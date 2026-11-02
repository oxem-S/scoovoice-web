/**
 * ScooVoice Web – Speicherung im localStorage
 *
 * Pairing-Keys pro Seriennummer (wie SessionStore.kt), calibration.json-Import
 * (nur verifizierte Punkte), App-Einstellungen.
 */
import { SpeedMap } from './protocol.js';

const KEY_STORE = 'scoovoice.keys';
const CAL_STORE = 'scoovoice.calibration';
const PREF_STORE = 'scoovoice.prefs';

const readJson = (k, def) => {
  try { return JSON.parse(localStorage.getItem(k)) ?? def; } catch { return def; }
};
const writeJson = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* daten UnsafeContext: leise weiter */ } };

/* ------------------------------------------------------------ Pairing-Keys */

export const keyStore = {
  /** {serial: app_random-Hex} */
  all() { return readJson(KEY_STORE, {}); },
  for(serial) { return this.all()[serial] ?? null; },
  save(serial, hex) {
    const all = this.all();
    all[serial] = hex;
    writeJson(KEY_STORE, all);
  },
  clear(serial) {
    const all = this.all();
    delete all[serial];
    writeJson(KEY_STORE, all);
  },
};

/** session.json des PC-Tools: {"name": ..., "app_random": ...} (auch als Array-Sammlung) */
export function importSessionJson(text) {
  const obj = JSON.parse(text);
  // Variante 1: einzelne Datei {name, app_random}
  if (obj && typeof obj.app_random === 'string') {
    const name = String(obj.name ?? '').trim();
    const hex = obj.app_random.toLowerCase();
    if (name && /^[0-9a-f]{32}$/.test(hex)) {
      keyStore.save(name, hex);
      return { name, hex };
    }
    throw new Error('session.json hat keinen brauchbaren app_random-Key (32 Hex-Zeichen)');
  }
  // Variante 2: Sammlung {devices:[{name, app_random}]} oder {<serial>: {app_random}}
  if (obj && Array.isArray(obj.devices)) {
    let n = 0;
    for (const d of obj.devices) {
      const hex = String(d.app_random ?? '').toLowerCase();
      if (d.name && /^[0-9a-f]{32}$/.test(hex)) { keyStore.save(String(d.name), hex); n++; }
    }
    if (n > 0) return { n };
    throw new Error('in session.json war kein gültiger Eintrag');
  }
  let n = 0;
  for (const [name, entry] of Object.entries(obj || {})) {
    const hex = String(entry?.app_random ?? '').toLowerCase();
    if (/^[0-9a-f]{32}$/.test(hex)) { keyStore.save(name, hex); n++; }
  }
  if (n > 0) return { n };
  throw new Error('session.json-Format unbekannt');
}

/* ------------------------------------------------------------- Kalibrierung */

export const calibrationStore = {
  json() { return localStorage.getItem(CAL_STORE) ?? ''; },
  parsed() {
    const t = this.json();
    return t ? SpeedMap.parseCalibration(t) : {};
  },
  set(text) { localStorage.setItem(CAL_STORE, text); },
  import(text) {
    const entries = SpeedMap.parseCalibration(text);
    if (Object.keys(entries).length === 0) throw new Error('calibration.json ohne verifizierte Punkte');
    this.set(text);
    return entries;
  },
};

/* ------------------------------------------------------------------ Prefs */

const PREF_DEFAULTS = {
  deviceName: '',
  wake: false,
  mode: 0, // 0 = Assist, 1 = Anti
  target: 20, wSpeed: 35, anti: 12, rangeMin: 10, rangeMax: 35,
  preset: 1, kp: 1.5, db: 2, ramp: 14, drop: 3, tol: 3,
  tiltCalib: '', // "z0,z1,z2|f0,f1,f2|targetDeg"
};

export const prefs = {
  get(k) {
    const all = readJson(PREF_STORE, {});
    if (!(k in all)) return PREF_DEFAULTS[k];
    return all[k];
  },
  set(k, v) {
    const all = readJson(PREF_STORE, {});
    all[k] = v;
    writeJson(PREF_STORE, all);
  },

  /** Tilt-Kalibrierung speichern (Nichachse + Nullpunkt), wie Prefs.setCalibData. */
  saveTiltCalib(z, f, targetDeg) {
    this.tiltCalib = `${z.join(',')}|${f.join(',')}|${targetDeg}`;
    this.set('tiltCalib', this.tiltCalib);
  },
  loadTiltCalib() {
    const s = this.get('tiltCalib');
    if (!s) return null;
    const parts = s.split('|');
    if (parts.length !== 3) return null;
    const z = parts[0].split(',').map(Number);
    const f = parts[1].split(',').map(Number);
    const target = Number(parts[2]);
    if (z.length === 3 && f.length === 3 && Number.isFinite(target)) return { z, f, target };
    return null;
  },
};
