/**
 * ScooVoice Web - reine Logik.
 *
 * 1:1-Port der Kotlin-Dateien (ohne Android-Abhaengigkeiten):
 *   - Command.kt / CommandController.kt
 *   - SongBook.kt
 *   - WheelieController.kt / AntiWheelieController.kt / WheelieTracker.kt
 *   - TelemetryFilter.kt
 *   - Calibration.kt (Vec3) inkl. der Nikki-Anzeige fuer laufende Kalibrierung
 *     (VoiceService.calibrationDisplayDeg)
 */

import { SpeedMap } from './protocol.js?v=2';

const clamp = (v, a, b) => Math.min(Math.max(v, a), b);
const toDeg = (rad) => (rad * 180) / Math.PI;

/* ------------------------------------------------------ Command.kt */
export const Command = {
  none: { type: 'None' },
  speed: (kmh) => ({ type: 'Speed', kmh }),
  zeroStart: { type: 'ZeroStart' },
  reset: { type: 'Reset' },
  panic: { type: 'Panic' },
  song: (number) => ({ type: 'Song', number }),
  launch: { type: 'Launch' },
  sicher: { type: 'Sicher' },
  tiltZero: { type: 'TiltZero' },
  angle: (deg) => ({ type: 'Angle', deg }),
  assistOn: { type: 'AssistOn' },
  assistOff: { type: 'AssistOff' },
};

/* ------------------------------------------- CommandController.kt */
export class CommandController {
  static COOLDOWN_MS = 2000;
  static MIN_CONFIDENCE = 0.35;
  /** Ziel-Max-Tempo der Kurzwort-Trigger (Reg 0x48). */
  static TOP_KMH = 35;

  static WAKE_WORDS = ['roller', 'scooter', 'scoot'];
  static ASSIST_WORDS = ['assistent', 'wheelie', 'wheely'];
  static ON_WORDS = ['an', 'ein', 'los', 'start'];
  static OFF_WORDS = ['aus', 'stopp', 'stop', 'ende'];

  /** Zielwinkel ausserhalb von NUM_WORDS (10..35). */
  static ANGLE_EXTRA = { fuenf: 5, vierzig: 40, fuenfundvierzig: 45 };
  static TOKEN_SPLIT = /[^a-z0-9]+/;

  static ZERO_START_PHRASES = [
    'zero start', 'null start', 'nullstart',
    'start null', 'anfahren null', 'anfahrschwelle null',
  ];
  static RESET_PHRASES = [
    'reset', 'ruecksetzen', 'rueck setzen',
    'werkszustand', 'werkseinstellung',
  ];
  static SONG_WORDS = ['song', 'lied'];

  /** Kleinzahlen fuer song; "ein" bewusst NICHT (Kollision mit "ein und zwanzig"). */
  static SONG_NUM = (() => {
    const m = { eins: 1, zwo: 2, zwei: 2, drei: 3, vier: 4, fuenf: 5, sechs: 6, sieben: 7, acht: 8, neun: 9 };
    for (let i = 1; i <= 9; i++) m[String(i)] = i; // Ziffern fuer Tests/PC-Tipperei
    return m;
  })();

  /** 10..35 auf Deutsch, Umlaute gefaltet (ue/ae/oe/ss). */
  static NUM_WORDS = (() => {
    const m = {};
    const putAll = (kmh, words) => words.forEach((w) => { m[w] = kmh; });
    putAll(10, ['zehn']);
    putAll(11, ['elf']);
    putAll(12, ['zwoelf']);
    putAll(13, ['dreizehn']);
    putAll(14, ['vierzehn']);
    putAll(15, ['fuenfzehn']);
    putAll(16, ['sechzehn']);
    putAll(17, ['siebzehn']);
    putAll(18, ['achtzehn']);
    putAll(19, ['neunzehn']);
    putAll(20, ['zwanzig']);
    putAll(30, ['dreissig']);
    for (const einer of [['ein', 1], ['zwei', 2], ['zwo', 2], ['drei', 3],
      ['vier', 4], ['fuenf', 5], ['sechs', 6], ['sieben', 7],
      ['acht', 8], ['neun', 9]]) {
      const [word, n] = einer;
      if (n === 1) putAll(21, ['einundzwanzig']);
      else putAll(20 + n, [`${word}undzwanzig`]);
      putAll(30 + n, [`${word}unddreissig`]);
    }
    putAll(35, ['fuenfunddreissig']); // Deckung wegen Sonderfall oben
    return m;
  })();

  constructor() {
    /** Zeitquelle austauschbar (Unit-Tests ohne Browser). */
    this.clock = () => performance.now();
    this.lastAcceptedAt = 0;
  }

  static fold(text) {
    return text.toLowerCase()
      .replaceAll('ß', 'ss')
      .replaceAll('ü', 'ue')
      .replaceAll('ä', 'ae')
      .replaceAll('ö', 'oe');
  }

  resetCooldown() { this.lastAcceptedAt = 0; }

  /** text = finales Transkript, confidence = dessen Angabe, wakeRequired = Einstellung. */
  handle(text, confidence, wakeRequired) {
    const C = CommandController;
    if (confidence < C.MIN_CONFIDENCE) return Command.none;
    const t = C.fold(text).trim();
    if (!t) return Command.none;

    const now = this.clock();
    if (now - this.lastAcceptedAt < C.COOLDOWN_MS) return Command.none;

    if (wakeRequired && !C.WAKE_WORDS.some((w) => t.includes(w))) return Command.none;

    // Kurzwort-Trigger: "start"/"sicher" ALLEIN gesprochen, ohne Zahl dahinter;
    // mit Wake-Wort als "roller start"/"roller sicher". Der Check sitzt direkt
    // nach dem Wake-Gate, VOR Zahl- und Phrasen-Passen: "start null" /
    // "zero start" ueberbruecken den Kurzwort bewusst.
    const restTokens = t.split(C.TOKEN_SPLIT).filter((x) => x !== '')
      .filter((x) => !C.WAKE_WORDS.includes(x));
    if (restTokens.length === 1 && restTokens[0] === 'start') {
      this.lastAcceptedAt = now;
      return Command.launch;
    }
    if (restTokens.length === 1 && restTokens[0] === 'sicher') {
      this.lastAcceptedAt = now;
      return Command.sicher;
    }

    // Wheelie-Assistent: VOR Zahl-Erkennung, sonst wuerde "winkel zwanzig" ein Tempo.
    if (restTokens.length > 0) {
      const first = restTokens[0];
      if (first === 'nullpunkt' || (first === 'null' && restTokens.length === 2 && restTokens[1] === 'punkt')) {
        this.lastAcceptedAt = now;
        return Command.tiltZero;
      }
      if (C.ASSIST_WORDS.includes(first)) {
        if (restTokens.length === 2 && C.ON_WORDS.includes(restTokens[1])) {
          this.lastAcceptedAt = now;
          return Command.assistOn;
        }
        if (restTokens.length === 2 && C.OFF_WORDS.includes(restTokens[1])) {
          this.lastAcceptedAt = now;
          return Command.assistOff;
        }
        return Command.none;
      }
      if (first === 'winkel') {
        const deg = parseAngle(restTokens.slice(1));
        if (deg != null && deg >= 5 && deg <= 45) {
          this.lastAcceptedAt = now;
          return Command.angle(deg);
        }
        return Command.none;
      }
    }

    // Song-Trigger: erstes Rest-Token "song"/"lied" -> die Aeusserung gehoert
    // komplett in den Song-Bereich. Genau EIN Kleinzahl-Token validiert den
    // Slot (1..6); alles andere wird geschluckt -> None (kein Tempo-Befehl).
    if (restTokens.length > 0 && C.SONG_WORDS.includes(restTokens[0])) {
      const n = restTokens.length === 2 ? C.SONG_NUM[restTokens[1]] : undefined;
      if (n != null && SongBook.validSlot(n)) {
        this.lastAcceptedAt = now;
        return Command.song(n);
      }
      return Command.none;
    }

    const kmh = parseNumber(t);
    if (kmh != null && SpeedMap.inRange(kmh)) {
      this.lastAcceptedAt = now;
      return Command.speed(kmh);
    }
    if (C.ZERO_START_PHRASES.some((p) => t.includes(p))) {
      this.lastAcceptedAt = now;
      return Command.zeroStart;
    }
    if (C.RESET_PHRASES.some((p) => t.includes(p))) {
      this.lastAcceptedAt = now;
      return Command.reset;
    }
    return Command.none;
  }
}

function parseAngle(tokens) {
  if (tokens.length === 0) return null;
  const C = CommandController;
  const joined = tokens.join('');
  if (C.ANGLE_EXTRA[joined] != null) return C.ANGLE_EXTRA[joined];
  if (C.NUM_WORDS[joined] != null) return C.NUM_WORDS[joined];
  return parseNumber(tokens.join(' '));
}

function parseNumber(t) {
  const C = CommandController;
  const tokens = t.split(C.TOKEN_SPLIT).filter((x) => x !== '');
  // 1. "und" als eigenes Wort: "zwei und zwanzig" (Erkennung trennt oft am "und")
  for (let i = 0; i < tokens.length - 2; i++) {
    if (tokens[i + 1] === 'und') {
      const hit = C.NUM_WORDS[tokens[i] + 'und' + tokens[i + 2]];
      if (hit != null) return hit;
    }
  }
  // 2. Einzel-Tokens (Normalfall: "zweiundzwanzig", "dreissig")
  for (const token of tokens) {
    const hit = C.NUM_WORDS[token];
    if (hit != null) return hit;
  }
  // 3. Paar-Verbindungen ohne "und" (Transkriptionsteile ohne Separator)
  for (let i = 0; i < tokens.length - 1; i++) {
    const hit = C.NUM_WORDS[tokens[i] + tokens[i + 1]];
    if (hit != null) return hit;
  }
  return null;
}

/* ------------------------------------------------------- SongBook.kt */
export const SongBook = {
  NAMES: ['Vierer', 'Kurz-Kurz-Lang', 'SOS', 'Herzschlag', 'Marsch', 'Rapid'],
  RHYTHMS: [
    [520, 520, 520, 0],
    [170, 170, 760, 170, 170, 0],
    [150, 150, 1100, 640, 640, 1100, 150, 0],
    [330, 1050, 330, 0],
    [170, 170, 900, 170, 170, 0],
    [130, 130, 130, 130, 130, 0],
  ],
  validSlot(n) { return n >= 1 && n <= this.RHYTHMS.length; },
  rhythm(n) { return this.validSlot(n) ? this.RHYTHMS[n - 1] : null; },
  name(n) { return this.validSlot(n) ? this.NAMES[n - 1] : null; },
};

/* ------------------------------------------- WheelieController.kt */
export class Preset {
  constructor(kp, tdSec, deadband, rampKmhPerSec, maxDrop, dropBase) {
    this.kp = kp;
    this.tdSec = tdSec;
    this.deadband = deadband;
    this.rampKmhPerSec = rampKmhPerSec;
    this.maxDrop = maxDrop;
    this.dropBase = dropBase;
  }
}

export const wheeliePresets = [
  new Preset(0.8, 0.20, 3.0, 8.0, 10.0, 2.0),
  new Preset(1.5, 0.30, 2.0, 14.0, 16.0, 3.0),
  new Preset(2.5, 0.40, 1.5, 24.0, 22.0, 4.0),
];

export class WheelieController {
  static DEFAULT_MIN = 10;
  static DEFAULT_MAX = 35;
  static DEFAULT_TARGET = 20;
  static TARGET_MIN = 5;
  static TARGET_MAX = 45;
  static HARD_OFFSET_DEG = 12;   // Ab Ziel + 12 Grad: sofort auf das Minimum
  static HOLD_OFFSET_KMH = 1;    // Limit im Totband = Tempo + 1 km/h
  static CAP_HEADROOM_KMH = 2;   // Spielraum ueber dem Wheelie-Tempo

  constructor() {
    this.minKmh = WheelieController.DEFAULT_MIN;
    this.maxKmh = WheelieController.DEFAULT_MAX;
    this.targetDeg = WheelieController.DEFAULT_TARGET;
    this.wheelieKmh = WheelieController.DEFAULT_MAX;  // 35 = aus
    const p = wheeliePresets[1];
    this.kp = p.kp;
    this.dropBase = p.dropBase;
    this.deadband = p.deadband;
    this.rampKmhPerSec = p.rampKmhPerSec;
    this.tdSec = p.tdSec;
    this.maxDrop = p.maxDrop;
    /** Zuletzt geschriebenes Limit (km/h). */
    this.limit = WheelieController.DEFAULT_MAX;
    this.limitF = this.limit;
  }

  setMin(v) { this.minKmh = clamp(Math.round(v), SpeedMap.KMH_MIN, SpeedMap.KMH_MAX); }
  setMax(v) { this.maxKmh = clamp(Math.round(v), SpeedMap.KMH_MIN, SpeedMap.KMH_MAX); }
  setTarget(v) { this.targetDeg = clamp(Math.round(v), WheelieController.TARGET_MIN, WheelieController.TARGET_MAX); }
  setWSpeed(v) { this.wheelieKmh = clamp(Math.round(v), SpeedMap.KMH_MIN, SpeedMap.KMH_MAX); }

  get lo() { return Math.min(this.minKmh, this.maxKmh); }
  get hi() { return Math.max(this.minKmh, this.maxKmh); }

  /** Preset laden (Vorhaltezeit/Maximal-Absenkung kommen nur aus dem Preset). */
  setTuning(kp, deadband, rampKmhPerSec, dropBase, presetIndex) {
    const p = wheeliePresets[clamp(Math.round(presetIndex), 0, wheeliePresets.length - 1)];
    this.kp = clamp(kp, 0.1, 4.0);
    this.deadband = clamp(deadband, 0.5, 8.0);
    this.rampKmhPerSec = clamp(rampKmhPerSec, 1.0, 40.0);
    this.dropBase = clamp(dropBase, 0.5, 10.0);
    this.tdSec = p.tdSec;
    this.maxDrop = p.maxDrop;
  }

  /** Start mit dem aktuell am Roller eingestellten Limit. */
  start(currentKmh) {
    this.limit = clamp(Math.round(currentKmh), this.lo, this.hi);
    this.limitF = this.limit;
  }

  /**
   * Gewuenschtes Limit (km/h, immer in minKmh..maxKmh).
   * speedKmh = gefiltertes Tempo oder null; dtSec = Zeit seit dem letzten Aufruf.
   */
  compute(angleDeg, rateDegPerSec, speedKmh, dtSec) {
    const loD = this.lo, hiD = this.hi;
    // Obergrenze fuers Beschleunigen/Halten: Wheelie-Tempo + Spielraum (aus bei 35)
    const capD = this.wheelieKmh >= this.hi
      ? hiD
      : clamp(this.wheelieKmh + WheelieController.CAP_HEADROOM_KMH, loD, hiD);
    if (angleDeg >= this.targetDeg + WheelieController.HARD_OFFSET_DEG) {
      this.limitF = loD;
      return this.lo;
    }
    const eff = (angleDeg - this.targetDeg) + this.tdSec * rateDegPerSec;
    const v = speedKmh;
    if (eff > this.deadband) {
      const drop = Math.min(this.dropBase + this.kp * (eff - this.deadband), this.maxDrop);
      const base = v ?? this.limitF;
      this.limitF = clamp(base - drop, loD, hiD);
    } else if (eff < -this.deadband) {
      const release = v != null ? v + WheelieController.HOLD_OFFSET_KMH : this.limitF;
      this.limitF = Math.min(capD, Math.max(this.limitF, release) + this.rampKmhPerSec * dtSec);
    } else if (v != null) {
      const hold = clamp(v + WheelieController.HOLD_OFFSET_KMH, loD, capD);
      // Hysterese: erst bei >= 1 km/h Abweichung nachziehen, damit das Limit nicht flattert
      if (Math.abs(hold - this.limitF) >= 1.0) this.limitF = hold;
    }
    this.limitF = clamp(this.limitF, loD, hiD);
    return clamp(Math.floor(this.limitF), this.lo, this.hi);
  }
}

/* --------------------------------------- AntiWheelieController.kt */
export class AntiWheelieController {
  static ANGLE_MIN = 5;
  static ANGLE_MAX = 35;
  static DEFAULT_ANGLE = 12;
  static ENGAGE_DEBOUNCE_MS = 120;
  static RELEASE_DEBOUNCE_MS = 100;
  static HYSTERESIS_DEG = 3.0;
  static RESTORE_RAMP_KMH_PER_S = 8.0;

  constructor() {
    this.angleDeg = AntiWheelieController.DEFAULT_ANGLE;
    this.engaged = false;
    this.restoreKmh = 22;
    this.limitF = 22;
    this.aboveSince = -1;
    this.belowSince = -1;
  }

  setAngle(v) { this.angleDeg = clamp(Math.round(v), AntiWheelieController.ANGLE_MIN, AntiWheelieController.ANGLE_MAX); }

  /** Start mit dem aktuell am Roller eingestellten Limit (wird spaeter wiederhergestellt). */
  start(currentKmh) {
    this.restoreKmh = clamp(Math.round(currentKmh), SpeedMap.KMH_MIN, SpeedMap.KMH_MAX);
    this.limitF = this.restoreKmh;
    this.engaged = false;
    this.aboveSince = -1;
    this.belowSince = -1;
  }

  compute(pitchDeg, nowMs, dtSec) {
    const A = AntiWheelieController;
    if (!this.engaged) {
      if (pitchDeg >= this.angleDeg) {
        if (this.aboveSince < 0) this.aboveSince = nowMs;
        if (nowMs - this.aboveSince >= A.ENGAGE_DEBOUNCE_MS) {
          this.engaged = true;
          this.belowSince = -1;
          this.limitF = SpeedMap.KMH_MIN;
        }
      } else {
        this.aboveSince = -1;
      }
    } else {
      this.limitF = SpeedMap.KMH_MIN;
      if (pitchDeg <= this.angleDeg - A.HYSTERESIS_DEG) {
        if (this.belowSince < 0) this.belowSince = nowMs;
        if (nowMs - this.belowSince >= A.RELEASE_DEBOUNCE_MS) {
          this.engaged = false;
          this.aboveSince = -1;
        }
      } else {
        this.belowSince = -1;
      }
    }
    if (!this.engaged && this.limitF < this.restoreKmh) {
      this.limitF = Math.min(this.restoreKmh, this.limitF + A.RESTORE_RAMP_KMH_PER_S * dtSec);
    }
    return clamp(Math.floor(this.limitF), SpeedMap.KMH_MIN, Math.max(SpeedMap.KMH_MIN, this.restoreKmh));
  }
}

/* ----------------------------------------------- WheelieTracker.kt */
export class WheelieTracker {
  static DEBOUNCE_MS = 100;
  /** Kuerzer als das zaehlt als Huckel, nicht als Wheelie. */
  static MIN_AIR_MS = 300;

  constructor() {
    this.phase = 'GROUND';
    /** Laufende Flugzeit (nur in AIR). */
    this.airMs = 0;
    /** Zeit seit der letzten Landung bzw. seit dem Reset. */
    this.groundMs = 0;
    this.bestAirMs = 0;
    this.count = 0;
    this.lastPeakDeg = 0;

    this.groundStart = 0;
    this.airStart = 0;
    this.candidate = -1;
    this.peak = 0;
    this.speedSum = 0;
    this.speedN = 0;
    this.speedMax = 0;
  }

  reset(nowMs) {
    this.phase = 'GROUND';
    this.airMs = 0;
    this.groundMs = 0;
    this.bestAirMs = 0;
    this.count = 0;
    this.lastPeakDeg = 0;
    this.groundStart = nowMs;
    this.candidate = -1;
    this.peak = 0;
    this.speedSum = 0;
    this.speedN = 0;
    this.speedMax = 0;
  }

  /** Neuer Messwert. Gibt einen Wert zurueck, wenn gerade ein Wheelie beendet wurde. */
  update(angleDeg, nowMs, targetDeg, speedKmh) {
    const on = clamp(targetDeg * 0.35, 3.0, 8.0);
    const off = on * 0.6;

    if (this.phase === 'GROUND') {
      this.groundMs = nowMs - this.groundStart;
      if (angleDeg >= on) {
        if (this.candidate < 0) this.candidate = nowMs;
        if (nowMs - this.candidate >= WheelieTracker.DEBOUNCE_MS) {
          this.phase = 'AIR';
          this.airStart = this.candidate;
          this.candidate = -1;
          this.peak = angleDeg;
          this.speedSum = 0;
          this.speedN = 0;
          this.speedMax = 0;
          this.airMs = nowMs - this.airStart;
        }
      } else {
        this.candidate = -1;
      }
      return null;
    }

    // Phase AIR
    this.airMs = nowMs - this.airStart;
    if (angleDeg > this.peak) this.peak = angleDeg;
    if (speedKmh != null) {
      this.speedSum += speedKmh;
      this.speedN++;
      if (speedKmh > this.speedMax) this.speedMax = speedKmh;
    }
    if (angleDeg <= off) {
      if (this.candidate < 0) this.candidate = nowMs;
      if (nowMs - this.candidate >= WheelieTracker.DEBOUNCE_MS) {
        const duration = this.candidate - this.airStart;
        const landedAt = this.candidate;
        this.phase = 'GROUND';
        this.candidate = -1;
        this.groundStart = landedAt;
        this.airMs = 0;
        this.groundMs = 0;
        if (duration < WheelieTracker.MIN_AIR_MS) return null;
        this.count++;
        if (duration > this.bestAirMs) this.bestAirMs = duration;
        this.lastPeakDeg = this.peak;
        const avg = this.speedN > 0 ? this.speedSum / this.speedN : NaN;
        return { airMs: duration, peakDeg: this.peak, avgSpeedKmh: avg, maxSpeedKmh: this.speedMax };
      }
    } else {
      this.candidate = -1;
    }
    return null;
  }
}

/* ----------------------------------------------- TelemetryFilter.kt */
export class TelemetryFilter {
  constructor(alpha = 0.5, maxJumpKmh = 8.0) {
    this.alpha = alpha;
    this.maxJumpKmh = maxJumpKmh;
    this.value = null;
    this.rejected = 0;
  }

  reset() {
    this.value = null;
    this.rejected = 0;
  }

  update(raw) {
    if (this.value == null) {
      this.value = raw;
      return raw;
    }
    if (Math.abs(raw - this.value) > this.maxJumpKmh && this.rejected < 2) {
      this.rejected++;
      return this.value;
    }
    this.rejected = 0;
    this.value = this.value + this.alpha * (raw - this.value);
    return this.value;
  }
}

/* ------------------------------------------------------------ Vec3 (Calibration.kt) */
export const Vec3 = {
  dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; },
  cross(a, b) {
    return [
      a[1] * b[2] - a[2] * b[1],
      a[2] * b[0] - a[0] * b[2],
      a[0] * b[1] - a[1] * b[0],
    ];
  },
  len(a) { return Math.sqrt(Vec3.dot(a, a)); },
  normalized(a) {
    const l = Vec3.len(a);
    return l < 1e-9 ? null : [a[0] / l, a[1] / l, a[2] / l];
  },
  angleDeg(a, b) { return toDeg(Math.acos(clamp(Vec3.dot(a, b), -1, 1))); },
  /**
   * Nickwinkel in Grad: Drehung von "oben" (u0) in Richtung Scooter-Laengsachse (f).
   * Seitliche Neigung (Drehung um f) bleibt aussen vor. Positiv = Richtung f.
   */
  pitchDeg(u, u0, f) { return toDeg(Math.atan2(Vec3.dot(u, f), Vec3.dot(u, u0))); },
};

/* ------------------------------------------------------- Calibration.kt */
export class Calibration {
  static MIN_TILT_DEG = 15;
  static MAX_TILT_DEG = 60;
  static START_DEG = 10;
  static GROUND_DEG = 5;
  static HOLD_MS = 3000;
  static MAX_OUTLIER_FRACTION = 0.2;

  constructor() {
    this.step = 'IDLE'; // IDLE | ZERO | RIGHT | LEFT | WHEELIE | DONE
    this.message = '';
    this.progress = 0;
    /** Toleranzband (Puffer) fuer das Halten der Wheelie-Hoehe. */
    this.tolDeg = 3;
    this.u0 = null;
    this.forward = null;
    this.targetDeg = 0;

    this.axisRight = null;
    this.windowStart = -1;
    this.sign = 1;
    this.values = [];
  }

  resetWindow() {
    this.windowStart = -1;
    this.values.length = 0;
    this.progress = 0;
  }

  start() {
    this.step = 'ZERO';
    this.u0 = null;
    this.forward = null;
    this.axisRight = null;
    this.targetDeg = 0;
    this.resetWindow();
    this.message = 'Schritt 1/4: Scooter gerade hinstellen, dann „Nullpunkt setzen“.';
  }

  cancel() {
    this.step = 'IDLE';
    this.message = '';
    this.resetWindow();
  }

  /** Button-Druck in den Schritten ZERO / RIGHT / LEFT. */
  capture(up) {
    const C = Calibration;
    switch (this.step) {
      case 'ZERO': {
        this.u0 = up.slice();
        this.step = 'RIGHT';
        this.message = 'Schritt 2/4: Scooter ca. 30° nach RECHTS neigen, halten, dann „Rechts übernehmen“.';
        break;
      }
      case 'RIGHT': {
        const z = this.u0;
        if (!z) break;
        const ang = Vec3.angleDeg(z, up);
        if (ang < C.MIN_TILT_DEG) {
          this.message = `Schritt 2/4: Erst ${ang.toFixed(0)}° geneigt – bitte ca. 30° nach RECHTS neigen und erneut übernehmen.`;
          break;
        }
        if (ang > C.MAX_TILT_DEG) {
          this.message = `Schritt 2/4: ${ang.toFixed(0)}° sind zu viel – bitte ca. 30° nach RECHTS neigen und erneut übernehmen.`;
          break;
        }
        const axis = Vec3.normalized(Vec3.cross(z, up));
        if (!axis) break;
        this.axisRight = axis;
        this.step = 'LEFT';
        this.message = 'Schritt 3/4: Scooter ca. 30° nach LINKS neigen, halten, dann „Links übernehmen“.';
        break;
      }
      case 'LEFT': {
        const z = this.u0;
        const a1 = this.axisRight;
        if (!z || !a1) break;
        const ang = Vec3.angleDeg(z, up);
        if (ang < C.MIN_TILT_DEG) {
          this.message = `Schritt 3/4: Erst ${ang.toFixed(0)}° geneigt – bitte ca. 30° nach LINKS neigen und erneut übernehmen.`;
          break;
        }
        if (ang > C.MAX_TILT_DEG) {
          this.message = `Schritt 3/4: ${ang.toFixed(0)}° sind zu viel – bitte ca. 30° nach LINKS neigen und erneut übernehmen.`;
          break;
        }
        const a2 = Vec3.normalized(Vec3.cross(z, up));
        if (!a2) break;
        if (Vec3.dot(a1, a2) > -0.85) {
          this.message = 'Schritt 3/4: Rechts und links passen nicht zusammen (Neigung muss seitlich sein, nicht nach vorn/hinten). Nochmal nach links neigen oder „Abbrechen“ und neu starten.';
          break;
        }
        const sum = [a1[0] - a2[0], a1[1] - a2[1], a1[2] - a2[2]];
        const d = Vec3.dot(sum, z);
        const f = Vec3.normalized([
          sum[0] - d * z[0], sum[1] - d * z[1], sum[2] - d * z[2],
        ]);
        if (!f) break;
        this.forward = f;
        this.step = 'WHEELIE';
        this.resetWindow();
        this.message = 'Schritt 4/4: Vorderrad anheben (über 10°) und die gewünschte Höhe 3 Sekunden halten.';
        break;
      }
      default:
        break;
    }
  }

  /** Laufend im Schritt WHEELIE aufrufen. true = Kalibrierung fertig. */
  feed(up, nowMs) {
    const C = Calibration;
    if (this.step !== 'WHEELIE') return false;
    const z = this.u0;
    const f = this.forward;
    if (!z || !f) return false;
    const p = Vec3.pitchDeg(up, z, f);
    const ap = Math.abs(p);
    if (ap < C.GROUND_DEG) {
      if (this.windowStart >= 0) {
        this.resetWindow();
        this.message = 'Schritt 4/4: Vorderrad anheben (über 10°) und die gewünschte Höhe 3 Sekunden halten.';
      }
      return false;
    }
    if (this.windowStart < 0) {
      if (ap < C.START_DEG) return false;
      this.windowStart = nowMs;
      this.sign = p >= 0 ? 1 : -1;
      this.values.length = 0;
    }
    this.values.push(p * this.sign);
    const elapsed = nowMs - this.windowStart;
    this.progress = clamp(elapsed / C.HOLD_MS, 0, 1);
    this.message = `Schritt 4/4: Höhe halten … ${(elapsed / 1000).toFixed(1)} s`;
    if (elapsed < C.HOLD_MS) return false;

    const sorted = this.values.slice().sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const outliers = this.values.filter((v) => Math.abs(v - median) > this.tolDeg).length;
    if (outliers / this.values.length <= C.MAX_OUTLIER_FRACTION && median >= C.START_DEG) {
      if (this.sign < 0) this.forward = [-f[0], -f[1], -f[2]];
      this.targetDeg = median;
      this.step = 'DONE';
      this.progress = 1;
      this.message = `Fertig: Wheelie-Höhe ${median.toFixed(1)}° gespeichert.`;
      return true;
    }
    this.message = `Zu unruhig (Toleranz ±${this.tolDeg.toFixed(0)}°) – bitte erneut 3 Sekunden halten.`;
    this.resetWindow();
    return false;
  }

  /**
   * Winkel, den die LAUFENDE Kalibrierung sieht (bis zur Fertigstellung gilt
   * "kalibriert = false" - frueher zeigte die Anzeige deshalb nur "-"):
   *  - RIGHT/LEFT: Kippwinkel gegenueber dem Nullpunkt aus Schritt 1 (Ziel ca. 30 Grad),
   *  - WHEELIE: Nickwinkel (Vorderrad hoch = Betrag) gegenueber der bestimmten Achse.
   */
  displayAngle(up) {
    if (!up) return null;
    const z = this.u0;
    if (!z) return null;
    if (this.step === 'RIGHT' || this.step === 'LEFT') return Vec3.angleDeg(z, up);
    if (this.step === 'WHEELIE' && this.forward) {
      return Math.abs(Vec3.pitchDeg(up, z, this.forward));
    }
    return null;
  }
}
