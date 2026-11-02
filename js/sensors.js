/**
 * ScooVoice Web - Neigungssensor (Port von TiltSensor.kt auf den Browser).
 *
 * Android nutzt GAME_ROTATION_VECTOR (200 Hz). Im Browser gibt es das Genauere
 * (Rotation-Vector) nur ueber sensor-fusionierte Events in Chrome; Portiert
 * wird ueber DeviceMotion "accelerationIncludingGravity":
 *   - normierter Messvektor = "oben" im Geraete-Koordinatensystem
 *     (Handy flach, Display nach oben -> (0,0,1), wie die 3. Matrixzeile unter Android).
 *   - iOS liefert das inverse Vorzeichen -> einmalige Spiegelung per UA-Erkennung.
 *   - Fallback: deviceorientation (ZXY) - 3. Zeile der Rotationsmatrix.
 *
 * Die Filter folgen exakt TiltSensor.kt: zeitbasierte Exponentialglättung
 * (TAU_UP 8 ms, TAU_PITCH 15 ms, TAU_RATE 40 ms) pro Messwert, Kalibrierung
 * (u0 = "oben" im Stand, f = Laengsachse) und danach NUR Nickwinkel.
 */

const TAU_UP_S = 0.008;
const TAU_PITCH_S = 0.015;
const TAU_RATE_S = 0.040;

const iOSDevice = () => /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

export class TiltSensor {
  constructor() {
    this.onSample = null;   // wird je Messwert aufgerufen (Regelung triggern)
    this.pitchDeg = 0;
    this.rateDegPerSec = 0;
    this.lastEventMs = 0;
    this.calibrated = false;
    this.hasData = false;   // haveUp

    this.useMotion = typeof (window.DeviceMotionEvent?.addEventListener) === 'function';
    this.useOrientation = typeof (window.DeviceOrientationEvent?.addEventListener) === 'function';
    this.running = false;
    this.flip = false;      // iOS-Konvention: Vorzeichen drehen

    this.upSm = [0, 0, 0];
    this.u0 = [0, 0, 0];
    this.fwd = [0, 0, 1];
    this.smoothedPitch = 0;
    this.lastRaw = 0;
    this.haveLastRaw = false;
    this.lastSampleTs = 0;

    this.#motionHandler = (ev) => this.#onMotion(ev);
    this.#orientHandler = (ev) => this.#onOrientation(ev);
  }

  #motionHandler;
  #orientHandler;

  get available() { return this.useMotion || this.useOrientation; }
  get hasCalibrationData() { return this.hasData; }

  /** Berechtigungsabfrage (iOS >= 13 braucht die in einer Nutzer-Geste). */
  static async requestPermission() {
    try {
      if (typeof DeviceMotionEvent?.requestPermission === 'function') {
        await DeviceMotionEvent.requestPermission();
      }
      if (typeof DeviceOrientationEvent?.requestPermission === 'function') {
        await DeviceOrientationEvent.requestPermission();
      }
      return true;
    } catch {
      return false;
    }
  }

  start() {
    if (this.running) return true;
    if (!this.available) return false;
    window.addEventListener('devicemotion', this.#motionHandler, { passive: true });
    window.addEventListener('deviceorientation', this.#orientHandler, { passive: true });
    this.running = true;
    return true;
  }

  stop() {
    if (!this.running) return;
    window.removeEventListener('devicemotion', this.#motionHandler);
    window.removeEventListener('deviceorientation', this.#orientHandler);
    this.running = false;
    this.hasData = false;
    this.lastSampleTs = 0;
  }

  /** Aktuelle, gefilterte "oben"-Richtung (Kopie). */
  upVector() { return [this.upSm[0], this.upSm[1], this.upSm[2]]; }

  setCalibration(zero, forward) {
    this.u0 = [zero[0], zero[1], zero[2]];
    this.fwd = [forward[0], forward[1], forward[2]];
    this.smoothedPitch = 0;
    this.pitchDeg = 0;
    this.rateDegPerSec = 0;
    this.haveLastRaw = false;
    this.calibrated = true;
  }

  clearCalibration() {
    this.calibrated = false;
  }

  /** Neuer Nullpunkt aus der aktuellen Lage, Achse bleibt (nur neu orthogonalisiert). */
  rezero() {
    if (!this.calibrated || !this.hasData) return false;
    const z = this.upVector();
    const f0 = [this.fwd[0], this.fwd[1], this.fwd[2]];
    const d = Vec3dot(f0, z);
    const f = Vec3normalized([f0[0] - d * z[0], f0[1] - d * z[1], f0[2] - d * z[2]]);
    if (!f) return false;
    this.setCalibration(z, f);
    return true;
  }

  /* -------------------------------------------------- Messverarbeitung */

  #onMotion(ev) {
    const g = ev.accelerationIncludingGravity;
    let x = 0, y = 0, z = 0;
    if (g && Number.isFinite(g.x) && Number.isFinite(g.y) && Number.isFinite(g.z)
      && (g.x !== 0 || g.y !== 0 || g.z !== 0)) {
      x = g.x; y = g.y; z = g.z;
    } else if (ev.acceleration && ev.acceleration.x != null) {
      // ohne Gravitation (selten, e.g. Desktop mit Sensor unterstellt) -> nichts Brauchbares
      x = y = z = 0;
    }
    if (x === 0 && y === 0 && z === 0) return;
    if (!this.flip) this.flip = iOSDevice();
    if (this.flip) { x = -x; y = -y; z = -z; }
    const l = Math.hypot(x, y, z);
    if (l < 1e-6) return;
    const now = performance.now();
    this.#applyRaw([x / l, y / l, z / l], now);
  }

  #onOrientation(ev) {
    // Fallback, falls devicemotion nicht feuert (Geraete ohne Beschleunigungsmesser).
    if (ev.beta == null || ev.gamma == null || ev.alpha == null) return;
    if (!this.running) return;
    // Wenn devicemotion vorhanden aber stumm, uebernehmen wir orientation erst,
    // wenn es mehrere Sekunden still war - sonst haette Motion Vorrang.
    const now = performance.now();
    if (this.useMotion && this.lastEventMs > 0 && now - this.lastEventMs < 3000) return;

    const rad = Math.PI / 180;
    const b = ev.beta * rad, c = ev.gamma * rad;
    const cb = Math.cos(b), sb = Math.sin(b);
    const cg = Math.cos(c), sg = Math.sin(c);
    // ZXY-Rotation aus W3C DeviceOrientation: R = Rz(alpha)*Rx(beta)*Ry(gamma).
    // Zeile 3 von R enthaelt alpha nicht (Rz-Zeile-3 = [0,0,1]):
    //   up_dev = [-cos(beta)*sin(gamma), sin(beta), cos(beta)*cos(gamma)]
    const q31 = -cb * sg;
    const q32 = sb;
    const q33 = cb * cg;
    const l = Math.hypot(q31, q32, q33);
    if (l < 1e-6) return;
    this.#applyRaw([q31 / l, q32 / l, q33 / l], now);
  }

  #applyRaw(up, nowMs) {
    const dt = this.lastSampleTs === 0 ? 0 : (nowMs - this.lastSampleTs) / 1000;
    this.lastSampleTs = nowMs;
    if (!this.hasData || dt <= 0 || dt > 0.2) {
      this.upSm[0] = up[0];
      this.upSm[1] = up[1];
      this.upSm[2] = up[2];
    } else {
      const a = 1 - Math.exp(-dt / TAU_UP_S);
      this.upSm[0] += a * (up[0] - this.upSm[0]);
      this.upSm[1] += a * (up[1] - this.upSm[1]);
      this.upSm[2] += a * (up[2] - this.upSm[2]);
      const n = Vec3normalized(this.upSm);
      if (n) this.upSm = n;
    }
    this.hasData = true;
    this.lastEventMs = nowMs;

    if (this.calibrated) {
      const raw = pitchDegOf(this.upSm, this.u0, this.fwd);
      if (dt > 0 && dt <= 0.2) {
        this.smoothedPitch += (1 - Math.exp(-dt / TAU_PITCH_S)) * (raw - this.smoothedPitch);
        if (this.haveLastRaw && dt > 0.001) {
          const r = (raw - this.lastRaw) / dt;
          this.rateDegPerSec += (1 - Math.exp(-dt / TAU_RATE_S)) * (r - this.rateDegPerSec);
        }
      } else {
        this.smoothedPitch = raw;
      }
      this.pitchDeg = this.smoothedPitch;
      this.lastRaw = raw;
      this.haveLastRaw = true;
    }
    this.onSample?.();
  }
}

/* Kleinere lokale Vektor-Helfer (gleiche Formel wie logic.js/Vec3). */
const clamp01 = (v, a, b) => Math.min(Math.max(v, a), b);

function Vec3dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }

function Vec3normalized(a) {
  const l = Math.sqrt(Vec3dot(a, a));
  return l < 1e-9 ? null : [a[0] / l, a[1] / l, a[2] / l];
}

function pitchDegOf(u, u0, f) {
  return (Math.atan2(Vec3dot(u, f), Vec3dot(u, u0)) * 180) / Math.PI;
}
