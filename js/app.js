/**
 * ScooVoice Web - UI-Glue (Port von VoiceService.kt auf den Browser).
 *
 * Befehle, PANIK-Knopf, Song, Wheelie-Assistent (Regel-/Telemetrieschleifen,
 * Failsafe), Kalibrierung - die Ablaeufe entsprechen dem Android-Dienst;
 * Browser-Ersatz: Web Bluetooth, DeviceMotion-Sensor, Web Speech API,
 * speechSynthesis statt Android-TTS.
 */

import { ScooterLink } from './link.js';
import {
  SpeedMap, latin1, fromHex, toHex,
  aes128KeySchedule, aesEncryptBlock16, NbCrypto,
} from './protocol.js';
import { keyStore, importSessionJson, calibrationStore, prefs } from './store.js';
import { TiltSensor } from './sensors.js';
import {
  Command, CommandController, SongBook,
  WheelieController, AntiWheelieController, WheelieTracker,
  TelemetryFilter, Calibration,
} from './logic.js';

/* ------------------------------------------------------------------ Dom */
const $ = (id) => document.getElementById(id);
const dom = {
  statusDot: $('statusDot'), statusText: $('statusText'), keyInfo: $('keyInfo'),
  btnConnect: $('btnConnect'), btnDisconnect: $('btnDisconnect'), btnImport: $('btnImport'),
  btnExportKey: $('btnExportKey'), serialInput: $('serialInput'), filePick: $('filePick'),
  btnVoice: $('btnVoice'), chkWake: $('chkWake'), chkTts: $('chkTts'),
  voiceText: $('voiceText'), actionText: $('actionText'),
  btnPanic: $('btnPanic'),
  speedText: $('speedText'), speedRow: $('speedRow'),
  btnZero: $('btnZero'), btnSong: $('btnSong'), songSlot: $('songSlot'),
  tiltAngle: $('tiltAngle'), tiltInfo: $('tiltInfo'), tiltStats: $('tiltStats'),
  calibMessage: $('calibMessage'), calibProgress: $('calibProgress'),
  btnCalibrate: $('btnCalibrate'), btnCalCancel: $('btnCalCancel'), btnAssist: $('btnAssist'),
  modeGroup: $('modeGroup'), presetGroup: $('presetGroup'), speedSource: $('speedSource'),
  log: $('log'), btnSelftest: $('btnSelftest'), selftestResult: $('selftestResult'),
  sliderTarget: $('sliderTarget'), outTarget: $('outTarget'),
  sliderWSpeed: $('sliderWSpeed'), outWSpeed: $('outWSpeed'),
  sliderAnti: $('sliderAnti'), outAnti: $('outAnti'),
  sliderMin: $('sliderMin'), outMin: $('outMin'),
  sliderMax: $('sliderMax'), outMax: $('outMax'),
  sliderKp: $('sliderKp'), outKp: $('outKp'),
  sliderDb: $('sliderDb'), outDb: $('outDb'),
  sliderRamp: $('sliderRamp'), outRamp: $('outRamp'),
  sliderDrop: $('sliderDrop'), outDrop: $('outDrop'),
  sliderTol: $('sliderTol'), outTol: $('outTol'),
};

const MAX_LOG_LINES = 150;
const MAX_SCROLL_LOG = () => { dom.log.scrollTop = dom.log.scrollHeight; };

function log(line) {
  const div = document.createElement('div');
  div.textContent = line;
  dom.log.appendChild(div);
  while (dom.log.childElementCount > MAX_LOG_LINES) dom.log.firstChild.remove();
  MAX_SCROLL_LOG();
}

const say = (spoken) => {
  if (!spoken) return;
  dom.actionText.textContent = `Aktion: ${spoken}`;
  if (dom.chkTts.checked && 'speechSynthesis' in window) {
    try {
      const u = new SpeechSynthesisUtterance(spoken);
      u.lang = 'de-DE';
      speechSynthesis.speak(u);
    } catch { /* TTS optional */ }
  }
};
const sayAndLog = (logline, spoken) => { log(logline); say(spoken); };

/* ------------------------------------------------------------ Zustand */
const link = new ScooterLink({ onLog: log, onState: showState, onSession, onRegister, onAuthenticated: onAuthenticated });
const controller = new CommandController();
const tilt = new TiltSensor();
const wheelie = new WheelieController();
const anti = new AntiWheelieController();
const tracker = new WheelieTracker();
const cal = new Calibration();
const speedFilter = new TelemetryFilter();

// PANIK-Knopf (UI): merkt die Werte vor dem ersten Druck und stellt sie beim zweiten Druck wieder her.
let panicOn = false;
let panicSavedReg42 = -1;
let panicSavedReg48 = -1;

// Wheelie-Assistent
let wheelieMode = 0;
let assistActive = false;
let assistSavedKmh = -1;
let assistStartedAt = 0;
let assistFails = 0;
let assistSpeedSource = 1;
let speedKmh = null;
let speedAtMs = 0;
let speedInvalid = 0;
let lastWriteAt = 0;
let lastWrittenKmh = -1;
let lastCycleAt = 0;
let lastVerifyAt = 0;
let verifyMismatch = 0;
let useAckWrites = false;
let lastAssistLogAt = 0;
let lastUiPush = 0;
let assistInterval = null;
let telemetryInterval = null;
let samplesFresh = false;
let cycleCount = 0;

// Kalibrierung
let tiltTickInterval = null;
let tiltLoopRunning = false;

let actionBusy = false;

let lastVoiceText = '';
let lastVoiceAt = 0;
let voiceOn = false;
let recognition = null;
const DEDUPE_MS = 300;

/* ------------------------------------------------------------- Helpers */
const le2 = (v) => new Uint8Array([v & 0xFF, (v >>> 8) & 0xFF]);
const le16 = (b) => (b[0] & 0xFF) | ((b[1] & 0xFF) << 8);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowMs = () => performance.now();
const fmt = (v, dig = 1) => (v == null || Number.isNaN(v)) ? '?' : Number(v).toFixed(dig);

const calibration = () => calibrationStore.parsed();

function showState(state) {
  const map = {
    scan: 'Suche …', connecting: 'Verbinde …', handshake: 'Handshake …',
    identity: '0x5B Identify …', 'fast-repair': 'Fast-Re-Pair …',
    propose: 'Pairing vorschlagen …', button_window: 'Warte auf Power-Button …',
    accept: 'Sitzung übernehmen …', authenticated: 'Verbunden',
    retry: 'Neuer Versuch …', disconnected: 'Getrennt',
    'handshake-failed': 'Handshake fehl – neuer Versuch', notfound: 'Kein Gerät',
  };
  dom.statusText.textContent = map[state] ?? state;
  dom.statusDot.className = 'dot' + (state === 'authenticated' ? ' ok' : (state !== 'disconnected' ? ' busy' : ''));
  const on = state === 'authenticated';
  dom.btnDisconnect.disabled = !on;
  dom.btnConnect.disabled = link.running;
  updateAssistButtons();
}

function onSession(serial, keyHex) {
  dom.keyInfo.textContent = `Key aktiv für ${serial} (app_random=${keyHex.slice(0, 8)}…)`;
  log(`[key] app_random=${keyHex} für ${serial} gesichert`);
  updateKeyInfo();
}

function updateKeyInfo() {
  if (link.authenticated) return;
  const saved = keyStore.all();
  const n = Object.keys(saved).length;
  dom.keyInfo.textContent = n === 0
    ? 'Kein Pairing-Key geladen.'
    : `${n} Key(s) gespeichert (${Object.keys(saved).join(', ')})`;
}

function onRegister(reg, raw) {
  if (reg === 0x48) {
    dom.speedText.textContent = `Max-Speed (0x48): ${SpeedMap.kmhFromRaw(raw)} km/h`;
  } else if (reg === 0x42) {
    log(`[reg] 0x42 = raw ${raw} (Anfahrschwelle)`);
  }
}

async function onAuthenticated() {
  // wie VoiceService: erst das Max-Tempo anzeigen, dann Failsafe pruefen
  const data = await link.readRegister(0x16, 0x48);
  if (data) {
    const kmh = SpeedMap.kmhFromRaw(le16(data));
    dom.speedText.textContent = `Max-Speed (0x48): ${kmh} km/h`;
    log(`[speed] aktuelles Max-Tempo: ${kmh} km/h`);
  }
  await maybeRestoreFailsafe();
}

/* -------------------------------------------------- Verbindung/Speicher */
dom.btnConnect?.addEventListener('click', async () => {
  if (link.running) return;
  link.nameHint = dom.serialInput.value.trim();
  try {
    await link.pickDevice();
  } catch (e) {
    log(`[!] Geräteauswahl abgebrochen (${e.name || ''})`);
    return;
  }
  showState('scan');
  link.startLoop();
});
dom.btnDisconnect?.addEventListener('click', () => {
  userStop();
});
function userStop() {
  if (assistActive) assistStop('Trennen');
  link.stopLoop();
}

dom.serialInput?.addEventListener('change', () => prefs.set('deviceName', dom.serialInput.value.trim()));

dom.btnImport?.addEventListener('click', () => dom.filePick.click());
dom.filePick?.addEventListener('change', async () => {
  const file = dom.filePick.files?.[0];
  if (!file) return;
  const text = await file.text();
  dom.filePick.value = '';
  try {
    if (text.includes('"app_random"') || text.includes('"random"')) {
      const msg = importSessionJson(text);
      log(`[import] ${msg.name ? `Key für ${msg.name} gespeichert (Fast-Re-Pair automatisch beim Verbinden)` : `${msg.n} Keys gespeichert`}`);
    } else if (text.includes('"entries"')) {
      const entries = calibrationStore.import(text);
      const n = Object.keys(entries).length;
      log(`[import] Kalibrierung übernommen: ${n} verifizierte Punkte (${Object.keys(entries).join(', ')} km/h)`);
    } else {
      throw new Error('unbekanntes JSON-Format');
    }
  } catch (e) {
    log(`[!] Import fehl: ${e.message}`);
  }
  updateKeyInfo();
});

dom.btnExportKey?.addEventListener('click', () => {
  const data = JSON.stringify(keyStore.all(), null, 2);
  try {
    const blob = new Blob([data], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'scoovoice-keys.json';
    a.click();
    URL.revokeObjectURL(a.href);
    log('[export] Keys als scoovoice-keys.json heruntergeladen');
  } catch (e) {
    log(`[-] Export fehl: ${e.message}`);
  }
  log(data);
});

/* ------------------------------------------------------------ Spracherkennung */
const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;

function startVoice() {
  if (voiceOn) return;
  if (!SpeechRec) {
    log('[!] Web Speech API fehlt (Chrome/Edge nutzen; Firefox/Safari nein)');
    return;
  }
  const rec = new SpeechRec();
  rec.lang = 'de-DE';
  rec.continuous = true;
  rec.interimResults = false;
  rec.maxAlternatives = 1;
  rec.onresult = (ev) => {
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const res = ev.results[i];
      if (!res.isFinal) continue;
      const alt = res[0];
      const text = alt?.transcript?.trim() ?? '';
      if (!text || text === '[unk]') continue;
      const now = Date.now();
      if (text === lastVoiceText && now - lastVoiceAt < DEDUPE_MS) continue;
      lastVoiceText = text;
      lastVoiceAt = now;
      dom.voiceText.textContent = `Sprache: „${text}“`;
      log(`[stimme] "${text}"`);
      let conf = alt?.confidence ?? 0;
      if (!conf || conf <= 0) conf = 1.0; // Chrome liefert teils 0 - wie Vosk ohne Wert
      const cmd = controller.handle(text, conf, dom.chkWake.checked);
      if (cmd && cmd.type !== 'None') execute(cmd);
    }
  };
  rec.onerror = (ev) => {
    log(`[speech] Fehler: ${ev.error}`);
    if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed') {
      voiceOn = false; dom.btnVoice.textContent = '🎙 Sprachsteuerung starten';
      say('Mikrofon gesperrt'); // Hinweis wie in der App
    }
  };
  rec.onend = () => {
    // Chrome beendet kontinuierliche Erkennung regelmaessig selbst -> neu starten
    if (voiceOn) {
      try { rec.start(); } catch { /* laeuft evtl. schon wieder */ }
    }
  };
  recognition = rec;
  voiceOn = true;
  try { rec.start(); } catch (e) { log(`[!] Mikrofon start nicht moeglich: ${e.message}`); return; }
  dom.btnVoice.textContent = '⏹ Sprachsteuerung beenden';
  log(`[voice] Erkennung gestartet (Web Speech API, ${dom.chkWake.checked ? 'mit' : 'ohne'} Wake-Wort)`);
}

function stopVoice() {
  voiceOn = false;
  try { recognition?.stop(); } catch { /* egal */ }
  recognition = null;
  dom.btnVoice.textContent = '🎙 Sprachsteuerung starten';
  log('[voice] Erkennung beendet');
}

dom.btnVoice?.addEventListener('click', () => {
  prefs.set('wake', dom.chkWake.checked);
  if (voiceOn) stopVoice(); else startVoice();
});
dom.chkWake?.addEventListener('change', () => prefs.set('wake', dom.chkWake.checked));

/* ------------------------------------------------------- Befehlskette */
function execute(cmd) {
  if (actionBusy) {
    log('[command] vorherige Aktion laeuft noch (max. 2 s) - verworfen');
    return;
  }
  actionBusy = true;
  executeInternal(cmd)
    .catch((e) => log(`[!] Aktion fehl: ${e.message?.slice(0, 80) || e}`))
    .finally(() => { actionBusy = false; });
}

async function executeInternal(cmd) {
  // Befehle, die den Roller nicht brauchen
  if (cmd.type === 'TiltZero') return doTiltZero();
  if (cmd.type === 'Angle') return doAngle(cmd.deg);
  if (cmd.type === 'AssistOff') {
    if (assistActive) assistStop('Sprachbefehl');
    else log('[assist] ist nicht aktiv');
    return;
  }
  if (cmd.type === 'Panic') return doPanic();

  // Waehrend der Assistent regelt, sind Tempo-Befehle gesperrt; Reset ist der Notausstieg.
  if (assistActive) {
    if (cmd.type === 'Speed' || cmd.type === 'Launch' || cmd.type === 'Sicher') {
      sayAndLog('[assist] aktiv - Tempo-Befehle gesperrt (erst "Assistent aus")', 'Assistent aktiv');
      return;
    }
    if (cmd.type === 'Reset') assistStop('Reset');
  }
  const l = link;
  if (!l || !l.authenticated || !l.connected) {
    sayAndLog('[order] nicht verbunden - Befehl verworfen', 'Nicht verbunden');
    return;
  }
  if (!await stationaryOk(l)) return;

  switch (cmd.type) {
    case 'Speed': {
      const result = await l.setSpeed(cmd.kmh, calibration());
      if (result.type === 'Applied') {
        sayAndLog(`[speed] ${result.raw} geschrieben (Ruecklesen ${SpeedMap.kmhFromRaw(result.readbackRaw)} km/h)`, `Tempo ${cmd.kmh} gesetzt`);
      } else if (result.type === 'Mismatch') {
        sayAndLog(`[speed] Ruecklesen ${SpeedMap.kmhFromRaw(result.readbackRaw)} km/h statt ${cmd.kmh} - Formel stimmt nicht, am PC kalibrieren`, `Achtung, Ruecklesen zeigt ${SpeedMap.kmhFromRaw(result.readbackRaw)}`);
      } else if (result.type === 'NoAck') {
        sayAndLog('[speed] kein ACK vom Roller', 'Der Roller hat nicht geantwortet');
      } else {
        sayAndLog('[speed] keine Verbindung', 'Nicht verbunden');
      }
      break;
    }
    case 'ZeroStart': {
      const [ack, rb] = await l.writeRegisterWithAck(0x16, 0x42, le2(0));
      const raw = rb ? le16(rb) : -1;
      if (ack && raw === 0) {
        sayAndLog('[zero] 0x42 = raw 0 - Anfahrschwelle auf 0', 'Anfahrschwelle auf null gesetzt');
      } else {
        sayAndLog(`[zero] 0x42 write-ack=${ack}, Ruecklesen raw=${raw}`, ack ? 'Anfahrschwelle geaendert, Ruecklesen pruefen' : 'Der Roller hat nicht geantwortet');
      }
      break;
    }
    case 'Reset': {
      // Werksbytes (Werksauslesen): 0x42 = 03 00 (Start 3 km/h), 0x48 = ff 16 (22 km/h)
      const first = await l.writeRegisterWithAck(0x16, 0x42, le2(3));
      const rb1raw = first[1] ? le16(first[1]) : -1;
      const second = await l.writeRegisterWithAck(0x16, 0x48, le2(0x16FF));
      const rb2raw = second[1] ? le16(second[1]) : -1;
      const ok = first[0] && rb1raw === 3 && second[0] && SpeedMap.kmhFromRaw(rb2raw) === 22;
      if (ok) {
        sayAndLog(`[reset] Werkszustand: 0x42 raw ${rb1raw}, 0x48 raw ${rb2raw} (${SpeedMap.kmhFromRaw(rb2raw)} km/h) - OK`, 'Werkszustand wiederhergestellt');
      } else {
        sayAndLog(`[reset] 0x42 ack=${first[0]} rb=${rb1raw}, 0x48 ack=${second[0]} rb=${rb2raw} - abweichend`, 'Ruecklesen weicht ab, Details im Protokoll');
      }
      break;
    }
    case 'Launch': {
      // Kurzwort "start": Anfahren 0 (Reg 0x42) direkt, danach Max-Tempo TOP_KMH.
      const [ack, rb] = await l.writeRegisterWithAck(0x16, 0x42, le2(0));
      const zeroRaw = rb ? le16(rb) : -1;
      const speed = await l.setSpeed(CommandController.TOP_KMH, calibration());
      const speedNote = speed.type === 'Applied'
        ? `Ruecklesen ${SpeedMap.kmhFromRaw(speed.readbackRaw)} km/h`
        : speed.type === 'Mismatch'
          ? `Ruecklesen ${SpeedMap.kmhFromRaw(speed.readbackRaw)} km/h - abweichend`
          : speed.type === 'NoAck' ? 'kein ACK' : 'keine Verbindung';
      const spoken = ack && speed.type === 'Applied'
        ? 'Anfahren freigegeben, Tempo hoch'
        : ack ? 'Anfahren freigegeben, Tempo nicht bestaetigt'
          : 'Der Roller hat nicht geantwortet';
      sayAndLog(`[launch] 0x42 ack=${ack} rb=${zeroRaw}, 0x48: ${speedNote}`, spoken);
      break;
    }
    case 'Sicher': {
      // Kurzwort "sicher": NUR Max-Tempo TOP_KMH.
      const result = await l.setSpeed(CommandController.TOP_KMH, calibration());
      if (result.type === 'Applied') {
        sayAndLog(`[sicher] ${result.raw} geschrieben (Ruecklesen ${SpeedMap.kmhFromRaw(result.readbackRaw)} km/h)`, 'Sicheres Tempo gesetzt');
      } else if (result.type === 'Mismatch') {
        sayAndLog(`[sicher] Ruecklesen ${SpeedMap.kmhFromRaw(result.readbackRaw)} km/h - Formel stimmt nicht, am PC kalibrieren`, 'Ruecklesen weicht ab, Details im Protokoll');
      } else if (result.type === 'NoAck') {
        sayAndLog('[sicher] kein ACK vom Roller', 'Der Roller hat nicht geantwortet');
      } else {
        sayAndLog('[sicher] keine Verbindung', 'Nicht verbunden');
      }
      break;
    }
    case 'Song':
      await playSong(l, cmd.number);
      break;
    case 'AssistOn':
      await assistStart(l);
      break;
    default:
      break;
  }
}

/** Best-Guess-Gate: Register 0x57 unbestaetigt! Lesen fehl oder ~0 -> im Stand. */
async function stationaryOk(l) {
  if (!prefs.get('stationaryOnly')) return true;
  const data = await l.readRegister(0x16, 0x57);
  const raw = data ? le16(data) : -1;
  const ok = data == null || raw <= 40;
  log(`[gate] 0x57 raw=${raw} -> ${ok ? 'im Stand (angenommen)' : 'faehrt - Befehl verworfen'}`);
  if (!ok) say('Scooter faehrt gerade - Befehl verworfen');
  return ok;
}

/* ------------------------------------------------------- Song (0x42-Takt) */
async function playSong(l, number) {
  const gaps = SongBook.rhythm(number);
  if (!gaps) { // defensiv - der Controller validiert den Slot schon
    log(`[song] Song ${number} ohne Takt-Zuordnung - verworfen`);
    return;
  }
  const savedData = await l.readRegister(0x16, 0x42);
  const saved = savedData ? le16(savedData) : -1;
  if (!(saved >= 0 && saved <= 3)) {
    sayAndLog(`[song] 0x42 Ruecklesen raw=${saved} - Startwert unklar, Song verworfen`, 'Anfahrschwelle unklar, Song verworfen');
    return;
  }
  const partner = saved === 0 ? 1 : saved - 1;
  sayAndLog(`[song] Song ${number} '${SongBook.name(number)}': 0x42 ${saved} <-> ${partner}, ${gaps.length} Steps`, `Spielt Song ${number}`, );

  let steps = 0;
  let lastTarget = saved;
  let aborted = false;
  for (let i = 0; i < gaps.length; i++) {
    const target = i % 2 === 0 ? partner : saved;
    const started = performance.now();
    const [ack, rb] = await l.writeRegisterWithAck(0x16, 0x42, le2(target));
    const raw = rb ? le16(rb) : -1;
    if (!ack || raw !== target) {
      aborted = true;
      sayAndLog(`[song] Step ${i + 1}: 0x42-Ziel ${target}, ack=${ack}, raw=${raw} - abgebrochen`, 'Song abgebrochen, Anfahrschwelle pruefen');
      break;
    }
    steps++;
    lastTarget = target;
    const remain = gaps[i] - (performance.now() - started);
    if (remain > 0) await sleep(remain);
  }
  if (lastTarget !== saved) {
    // Wiederherstellen ist auch eine Aenderung -> zusaetzlicher Beep moeglich.
    const [rAck, rRb] = await l.writeRegisterWithAck(0x16, 0x42, le2(saved));
    const rRaw = rRb ? le16(rRb) : -1;
    log(`[song] 0x42 zurueck auf ${saved}: ack=${rAck}, raw=${rRaw}`);
  }
  if (!aborted) {
    sayAndLog(`[song] Song ${number} '${SongBook.name(number)}' fertig: ${steps} Steps, 0x42 wieder ${saved}`, 'Song fertig');
  }
}

/* ------------------------------------------------------ PANIK (UI-Knopf) */
dom.btnPanic?.addEventListener('click', () => {
  controller.resetCooldown();
  execute(Command.panic);
});

function onPanicState(active) {
  dom.btnPanic.classList.toggle('active', active);
  dom.btnPanic.textContent = active
    ? '🚨 PANIK AKTIV – nochmal drücken: gemerkte Werte zurück'
    : '🚨 PANIK: 22 km/h & Null-Start aus';
}

/**
 * 1. Druck: aktuellen 0x42/0x48-Rohwert NACHRICHTEN-getreu lesen und merken,
 *    danach Werksbytes schreiben (0x42 = 03 00 -> Nullstart aus, 0x48 = ff 16 -> 22 km/h).
 * 2. Druck: die gemerkten Rohwerte byte-exakt zurueckschreiben.
 */
async function doPanic() {
  const l = link;
  if (!l || !l.authenticated || !l.connected) {
    sayAndLog('[panic] nicht verbunden - Knopfdruck verworfen', 'Nicht verbunden');
    return;
  }
  if (assistActive) {
    // Sicherheit zuerst: laufende Regelung stoppen (stellt ihr Start-Limit selbst wieder her).
    assistStop('Panik');
    if (panicOn) {
      await panicRestore(l);
      return;
    }
  }
  if (panicOn) await panicRestore(l);
  else await panicApply(l);
}

const PANIC_KMH = 22;
const PANIC_RAW_48 = 0x16FF;
const PANIC_START_START = 3;

async function panicApply(l) {
  // Nur beim ERSTEN Versuch merken; ein Wiederholungsversuch nach halb
  // geschriebener Panik wuerde sonst die Panic-Bytes als "alt" einfangen.
  if (panicSavedReg42 < 0 || panicSavedReg48 < 0) {
    const d42 = await l.readRegister(0x16, 0x42);
    panicSavedReg42 = d42 ? le16(d42) : -1;
    const d48 = await l.readRegister(0x16, 0x48);
    panicSavedReg48 = d48 ? le16(d48) : -1;
    if (panicSavedReg42 < 0 || panicSavedReg48 < 0) {
      panicSavedReg42 = -1;
      panicSavedReg48 = -1;
      sayAndLog('[panic] Roller nicht lesbar (0x42/0x48) - nichts geaendert', 'Roller nicht lesbar, nichts geaendert');
      return;
    }
    log(`[panic] gemerkt: 0x42 raw ${panicSavedReg42}, 0x48 raw ${panicSavedReg48} (${SpeedMap.kmhFromRaw(panicSavedReg48)} km/h)`);
  }
  const first = await l.writeRegisterWithAck(0x16, 0x42, le2(PANIC_START_START));
  const rb1 = first[1] ? le16(first[1]) : -1;
  const second = await l.writeRegisterWithAck(0x16, 0x48, le2(PANIC_RAW_48));
  const rb2 = second[1] ? le16(second[1]) : -1;
  const ok = first[0] && rb1 === PANIC_START_START && second[0] && SpeedMap.kmhFromRaw(rb2) === PANIC_KMH;
  if (!ok) {
    // Panik bleibt NICHT aktiv; die gemerkten Werte bleiben trotzdem erhalten.
    sayAndLog(`[panic] 0x42 ack=${first[0]} rb=${rb1}, 0x48 ack=${second[0]} rb=${rb2} - abweichend`, 'Panik nicht bestaetigt - Details im Protokoll');
    return;
  }
  panicOn = true;
  onPanicState(true);
  sayAndLog(`[panic] AN: 0x42 raw ${rb1} (Start 3 km/h, Nullstart aus), 0x48 raw ${rb2} (${SpeedMap.kmhFromRaw(rb2)} km/h). Nochmal druecken = gemerkte Werte zurück.`, 'Panik: 22 km/h, Nullstart aus');
}

async function panicRestore(l) {
  const saved42 = panicSavedReg42;
  const saved48 = panicSavedReg48;
  if (saved42 < 0 || saved48 < 0) {
    panicOn = false;
    panicSavedReg42 = -1;
    panicSavedReg48 = -1;
    onPanicState(false);
    log('[panic] Zustand zurueckgesetzt, aber keine gemerkten Werte vorhanden');
    return;
  }
  const first = await l.writeRegisterWithAck(0x16, 0x42, le2(saved42));
  const rb1 = first[1] ? le16(first[1]) : -1;
  const second = await l.writeRegisterWithAck(0x16, 0x48, le2(saved48));
  const rb2 = second[1] ? le16(second[1]) : -1;
  const ok = first[0] && rb1 === saved42 && second[0] && rb2 === saved48;
  if (!ok) {
    // Zustand unaufgeraeumt lassen: Nochmal druecken versucht die Wiederherstellung erneut.
    sayAndLog(`[panic] Wiederherstellen nicht bestaetigt (0x42 ack=${first[0]} rb=${rb1}, 0x48 ack=${second[0]} rb=${rb2}) - nochmal druecken`, 'Panik nicht aufgehoben, nochmal druecken');
    return;
  }
  panicOn = false;
  panicSavedReg42 = -1;
  panicSavedReg48 = -1;
  onPanicState(false);
  sayAndLog(`[panic] AUS: Werte von vor dem Knopfdruck zurueck (0x42 raw ${rb1}, 0x48 raw ${rb2} = ${SpeedMap.kmhFromRaw(rb2)} km/h)`, 'Panik aus, alte Werte zurück');
}

function resetPanicOnNavigate() {
  if (panicOn) {
    log('[panic] Seite verlassen - Panik-Zustand bleibt am Roller (22 km/h, Start 3 km/h); die gemerkten Werte sind nicht mehr wiederholbar');
  }
  if (assistActive) {
    log(`[assist] Seite verlassen - Limit bleibt auf ${wheelie.limit} km/h, wird beim naechsten Verbinden wiederhergestellt (Failsafe)`);
  }
}

/* ------------------------------------------------- Tempo-Zahlen / Zero / Song */
for (let kmh = SpeedMap.KMH_MIN; kmh <= SpeedMap.KMH_MAX; kmh++) {
  const b = document.createElement('button');
  b.className = 'btn outline';
  b.textContent = String(kmh);
  b.addEventListener('click', () => execute(Command.speed(kmh)));
  dom.speedRow.appendChild(b);
}
dom.btnZero?.addEventListener('click', () => execute(Command.zeroStart));
dom.btnSong?.addEventListener('click', () => execute(Command.song(parseInt(dom.songSlot.value, 10))));

/* ------------------------------------------------------- Wheelie-Assistent */
function reloadWheelieConfig() {
  wheelie.setMin(prefs.get('rangeMin'));
  wheelie.setMax(prefs.get('rangeMax'));
  wheelie.setTarget(prefs.get('target'));
  const p = prefs.get('preset');
  wheelie.setTuning(prefs.get('kp'), prefs.get('db'), prefs.get('ramp'), prefs.get('drop'), p);
  wheelie.setWSpeed(prefs.get('wSpeed'));
  anti.setAngle(prefs.get('anti'));
  cal.tolDeg = prefs.get('tol');
  if (!assistActive) wheelieMode = prefs.get('mode');
  assistSpeedSource = prefs.get('speedSource') ?? 1;
}

function loadCalibration() {
  const c = prefs.loadTiltCalib();
  if (c) tilt.setCalibration(c.z, c.f);
}

function ensureTiltLoop() {
  if (tiltLoopRunning) return;
  if (!tilt.start()) {
    log('[tilt] Kein Neigungs-/Bewegungssensor verfügbar');
    return;
  }
  tiltLoopRunning = true;
  tilt.onSample = () => { samplesFresh = true; };
  tiltTickInterval = setInterval(() => { tick().catch((e) => log(`[tick] ${e.message}`)); }, 100);
}

function stopTiltLoopIfIdle() {
  if (assistActive) return;
  tiltLoopRunning = false;
  clearInterval(tiltTickInterval);
  tiltTickInterval = null;
  tilt.stop();
  tilt.onSample = null;
}

function calibrationDisplayDeg() {
  const z = cal.u0;
  if (!z || !tilt.hasData) return null;
  return cal.displayAngle(tilt.upVector());
}

function pushTiltUi(now, force = false) {
  if (!force && now - lastUiPush < 100) return;
  lastUiPush = now;
  const calibDeg = calibrationDisplayDeg();
  const angle = calibDeg !== null ? calibDeg : (tilt.calibrated ? tilt.pitchDeg : null);
  const zeroSet = tilt.calibrated || calibDeg !== null;
  dom.tiltAngle.textContent = angle == null ? '–' : `${angle.toFixed(1)}°`;
  dom.tiltInfo.textContent = zeroSet
    ? `Ziel ${wheelie.targetDeg}° · Limit ${wheelie.limit} km/h${speedKmh != null ? ` · ${speedKmh.toFixed(1)} km/h` : ''}`
    : 'Nicht kalibriert';
  dom.tiltStats.textContent = `Boden ${fmt(tracker.groundMs / 1000)} s · Best ${fmt(tracker.bestAirMs / 1000)} s · Wheelies ${tracker.count}`;

  // Kalibrier-Meldung/Progress
  dom.calibMessage.style.display = cal.message ? 'block' : 'none';
  dom.calibMessage.textContent = cal.message;
  if (cal.step === 'WHEELIE') {
    dom.calibProgress.style.display = 'block';
    dom.calibProgress.value = Math.round(cal.progress * 100);
  } else {
    dom.calibProgress.style.display = 'none';
  }
  // Kalibrier-Button je Schritt
  const labels = {
    IDLE: 'Kalibrieren', DONE: 'Neu kalibrieren',
    ZERO: 'Nullpunkt setzen', RIGHT: 'Rechts übernehmen',
    LEFT: 'Links übernehmen', WHEELIE: 'Halten …',
  };
  dom.btnCalibrate.textContent = labels[cal.step] ?? 'Kalibrieren';
  dom.btnCalibrate.style.display = cal.step === 'WHEELIE' ? 'none' : '';
  dom.btnCalCancel.style.display = cal.step !== 'IDLE' && cal.step !== 'DONE' ? '' : 'none';

  updateModeUi();
  updateAssistButtons();
}

function updateModeUi() {
  dom.modeGroup.querySelectorAll('button').forEach((b) => {
    b.classList.toggle('checked', parseInt(b.dataset.mode, 10) === wheelieMode);
  });
  dom.presetGroup.querySelectorAll('button').forEach((b) => {
    b.classList.toggle('checked', parseInt(b.dataset.p, 10) === prefs.get('preset'));
  });
}

function updateAssistButtons() {
  const conn = link.authenticated && link.connected;
  const ready = conn && tilt.calibrated;
  dom.btnAssist.disabled = !ready && !assistActive;
  dom.btnAssist.textContent = assistActive ? '⏹ Stoppen' : '▶ Starten';
  dom.btnCalibrate.disabled = assistActive;
  dom.btnPanic.disabled = false;
}

let tickBusy = false;
async function tick() {
  if (tickBusy) return;
  tickBusy = true;
  try {
    const now = nowMs();
    if (cal.step === 'WHEELIE' && tilt.hasData) {
      if (cal.feed(tilt.upVector(), now)) onCalibrationFinished(now);
    }
    pushTiltUi(now);
    if (tilt.calibrated) {
      const fin = tracker.update(tilt.pitchDeg, now, wheelie.targetDeg, speedKmh);
      if (fin) onWheelieFinished(fin);
    }
  } finally {
    tickBusy = false;
  }
}

function onWheelieFinished(f) {
  const v = Number.isNaN(f.avgSpeedKmh) ? '?' : f.avgSpeedKmh.toFixed(1);
  log(`[wheelie] #${tracker.count}: Air ${fmt(f.airMs / 1000)} s | Peak ${f.peakDeg.toFixed(1)} Grad (Ziel ${wheelie.targetDeg}) | Tempo Ø ${v} km/h (max ${fmt(f.maxSpeedKmh)}) | Best ${fmt(tracker.bestAirMs / 1000)} s`);
}

dom.btnCalibrate?.addEventListener('click', () => {
  if (assistActive) {
    log('[kal] bitte erst den Assistenten stoppen');
    return;
  }
  if (cal.step === 'IDLE' || cal.step === 'DONE') {
    ensureTiltLoop();
    cal.start();
  } else if (cal.step === 'ZERO' || cal.step === 'RIGHT' || cal.step === 'LEFT') {
    if (!tilt.hasData) log('[kal] noch keine Sensordaten - bitte kurz warten');
    else cal.capture(tilt.upVector());
  }
  pushTiltUi(nowMs(), true);
});
dom.btnCalCancel?.addEventListener('click', () => {
  cal.cancel();
  pushTiltUi(nowMs(), true);
});

function onCalibrationFinished(now) {
  const z = cal.u0;
  const f = cal.forward;
  if (!z || !f) return;
  tilt.setCalibration(z, f);
  prefs.saveTiltCalib(z, f, cal.targetDeg);
  const t = Math.min(45, Math.max(5, Math.round(cal.targetDeg)));
  wheelie.setTarget(t);
  prefs.set('target', t);
  tracker.reset(now);
  log(`[kal] fertig: Zielwinkel ${t} Grad gespeichert, Nickachse bestimmt`);
  pushTiltUi(now, true);
}

// Kalibrierung ohne Sprachbefehl: Buttons steuern; "Nullpunkt"/"Assistent an/aus"/"Winkel N" via Sprache.
function doTiltZero() {
  // Assistent aktiv -> gesperrt (wie VoiceService.doTiltZero)
  if (assistActive) {
    sayAndLog('[tilt] Assistent aktiv - Nullpunkt gesperrt', 'Erst Assistent aus');
    return;
  }
  if (!tilt.calibrated) {
    sayAndLog('[tilt] erst kalibrieren (Button "Kalibrieren")', 'Erst kalibrieren');
    return;
  }
  ensureTiltLoop();
  if (tilt.rezero()) {
    tracker.reset(nowMs());
    sayAndLog('[tilt] Nullpunkt neu gesetzt (Achse bleibt)', 'Nullpunkt gesetzt');
  } else {
    sayAndLog('[tilt] noch keine Sensordaten', 'Keine Sensordaten');
  }
}

function doAngle(deg) {
  wheelie.setTarget(deg);
  prefs.set('target', wheelie.targetDeg);
  sayAndLog(`[tilt] Zielwinkel ${wheelie.targetDeg} Grad`, `Winkel ${wheelie.targetDeg}`);
  dom.sliderTarget.value = String(wheelie.targetDeg);
  dom.outTarget.textContent = String(wheelie.targetDeg);
  pushTiltUi(nowMs(), true);
}

/* ------------------------------------------------------- Assist-Regelkreis */
dom.btnAssist?.addEventListener('click', () => {
  if (assistActive) execute(Command.assistOff);
  else execute(Command.assistOn);
});

async function assistStart(l) {
  if (assistActive) {
    log('[assist] laeuft schon');
    return;
  }
  ensureTiltLoop();
  if (!tilt.available) {
    sayAndLog('[assist] kein Neigungssensor', 'Kein Neigungssensor');
    return;
  }
  if (!tilt.calibrated) {
    sayAndLog('[assist] erst kalibrieren', 'Erst kalibrieren');
    return;
  }
  reloadWheelieConfig();
  const currentData = await l.readRegister(0x16, 0x48);
  const current = currentData ? SpeedMap.kmhFromRaw(le16(currentData)) : -1;
  if (!SpeedMap.inRange(current)) {
    sayAndLog(`[assist] aktuelles Tempo unklar (${current}) - nicht gestartet`, 'Tempo unklar, nicht gestartet');
    return;
  }
  assistSavedKmh = current;
  prefs.set('failsafe', current); // bleibt gespeichert, bis das Limit sicher zurueckgeschrieben wurde
  wheelie.start(current);
  anti.start(current);
  lastAntiEngaged = false;
  speedKmh = null;
  speedFilter.reset();
  speedInvalid = 0;
  tracker.reset(nowMs());
  lastWriteAt = 0;
  lastWrittenKmh = current;
  lastCycleAt = 0;
  lastVerifyAt = nowMs();
  verifyMismatch = 0;
  useAckWrites = false;
  lastAssistLogAt = 0;
  assistFails = 0;
  assistStartedAt = nowMs();
  samplesFresh = false;
  cycleCount = 0;
  speedAtMs = 0;
  assistActive = true;
  assistInterval = setInterval(() => controlCycle().catch((e) => {
    log(`[assist] Fehler im Regelkreis: ${e.message}`);
    assistStop('Fehler');
  }), 50);
  telemetryInterval = setInterval(() => telemetryCycle().catch((e) => {
    log(`[assist] Fehler in der Telemetrie: ${e.message}`);
    assistStop('Fehler');
  }), 30);
  const what = wheelieMode === 1
    ? `Anti-Wheelie: Grenzwinkel ${anti.angleDeg} Grad`
    : `Assist: Ziel ${wheelie.targetDeg} Grad, Tempo ${wheelie.minKmh}..${wheelie.maxKmh}`;
  sayAndLog(`[assist] an (${what}), Start ${current} km/h`, wheelieMode === 1 ? 'Anti Wheelie an' : 'Assistent an');
  pushTiltUi(nowMs(), true);
}

/** Beendet die Regelung und stellt das Limit von vor dem Start wieder her. */
function assistStop(reason) {
  if (!assistActive) return;
  assistActive = false;
  clearInterval(assistInterval);
  clearInterval(telemetryInterval);
  assistInterval = null;
  telemetryInterval = null;
  const l = link;
  const saved = assistSavedKmh;
  speedKmh = null;
  let restored = false;
  if (l && l.authenticated && l.connected && SpeedMap.inRange(saved)) {
    // Feuert ohne await - setSpeed serialisiert selbst ueber die Mutex-Kette
    l.setSpeed(saved, calibration()).then((r) => {
      restored = r.type === 'Applied';
      if (restored) prefs.set('failsafe', -1);
      log(`[assist] aus (${reason}), Limit zurueck auf ${saved} km/h: ${restored ? 'OK' : 'NICHT bestaetigt - wird beim naechsten Verbinden wiederhergestellt'}`);
    }).catch(() => {
      log(`[assist] aus (${reason}), Limit zurueck auf ${saved} km/h: NICHT bestaetigt - wird beim naechsten Verbinden wiederhergestellt`);
    });
  } else {
    log(`[assist] aus (${reason}), Limit zurueck auf ${saved} km/h: NICHT bestaetigt - wird beim naechsten Verbinden wiederhergestellt`);
  }
  wheelie.limit = SpeedMap.inRange(saved) ? saved : wheelie.limit;
  say('Assistent aus');
  pushTiltUi(nowMs(), true);
}

async function controlCycle() {
  const now = nowMs();
  const l = link;
  if (!l || !l.authenticated || !l.connected) {
    assistStop('Verbindung weg');
    return;
  }
  if (now - tilt.lastEventMs > 600) {
    assistStop('Sensor liefert keine Werte');
    return;
  }
  if (now - assistStartedAt > 10 * 60 * 1000) {
    assistStop('Zeitlimit erreicht');
    return;
  }
  const fresh = samplesFresh;
  samplesFresh = false;
  if (!fresh) return;
  cycleCount++;
  const pitch = tilt.pitchDeg;
  const rate = tilt.rateDegPerSec;
  const dt = lastCycleAt === 0 ? 0.005 : Math.min(0.2, Math.max(0.001, (now - lastCycleAt) / 1000));
  lastCycleAt = now;

  // Limit berechnen und SOFORT schreiben (nur der neueste Wert, nur bei Aenderung um >= 1 km/h)
  const desired = wheelieMode === 1
    ? anti.compute(pitch, now, dt)
    : wheelie.compute(pitch, rate, speedKmh, dt);
  if (wheelieMode === 1 && anti.engaged !== lastAntiEngaged) {
    lastAntiEngaged = anti.engaged;
    log(anti.engaged
      ? `[anti] AUSGELOEST bei ${pitch.toFixed(1)} Grad -> Limit ${SpeedMap.KMH_MIN} km/h`
      : '[anti] frei - Limit wird sanft wiederhergestellt');
  }
  if (desired !== wheelie.limit && now - lastWriteAt >= 12) {
    lastWriteAt = now;
    const ok = useAckWrites
      ? (await l.setSpeed(desired, assistCalib())).type === 'Applied'
      : await l.setSpeedFast(desired, assistCalib());
    if (ok) {
      wheelie.limit = desired;
      lastWrittenKmh = desired;
      assistFails = 0;
    } else {
      assistFails++;
      log(`[assist] Schreiben von ${desired} km/h fehlgeschlagen (${assistFails}/3)`);
      if (assistFails >= 3) {
        assistStop('Schreiben schlaegt fehl');
        return;
      }
    }
  }

  // 1x pro Sekunde eine Zeile ins Protokoll (zum Nachtuen) inkl. Zeitmessung
  if (now - lastAssistLogAt >= 1000) {
    const secs = lastAssistLogAt === 0 ? 1 : (now - lastAssistLogAt) / 1000;
    lastAssistLogAt = now;
    const v = speedKmh != null ? `${speedKmh.toFixed(1)} km/h` : '?';
    const age = speedAtMs === 0 ? -1 : now - speedAtMs;
    log(`[${wheelieMode === 1 ? 'anti' : 'assist'}] ${pitch.toFixed(1)} Grad (${rate >= 0 ? '+' : ''}${rate.toFixed(0)} Grad/s) | Tempo ${v} | Limit ${wheelie.limit} | ${useAckWrites ? 'bestaetigt' : 'schnell'} | ${(cycleCount / secs).toFixed(0)} Werte/s, Tempo-Alter ${age} ms`);
    cycleCount = 0;
  }
}
let lastAntiEngaged = false;

function assistCalib() {
  return calibration();
}

async function telemetryCycle() {
  const l = link;
  if (!l || !l.authenticated || !l.connected) return;
  if (assistSpeedSource !== 0) {
    const reg = assistSpeedSource === 2 ? 0x26 : 0x57;
    const t0 = nowMs();
    const data = await l.readRegisterFast(0x16, reg, 2, 120);
    const t1 = nowMs();
    const raw = data ? le16(data) : null;
    if (raw != null && raw >= 0 && raw <= 600) {
      speedKmh = speedFilter.update(raw / 10.0);
      speedAtMs = t1;
      speedInvalid = 0;
    } else {
      speedInvalid++;
      if (speedInvalid >= 5 && speedKmh != null) {
        speedKmh = null;
        speedFilter.reset();
        log(`[assist] Tempo-Register 0x${reg.toString(16)} liefert keine brauchbaren Werte (raw=${raw}) - regle nur nach Winkel`);
      }
    }
  }
  // Stichprobe: ist das Limit am Roller wirklich angekommen? (nur im Schnellmodus)
  const now = nowMs();
  if (!useAckWrites && now - lastVerifyAt >= 2500 && now - lastWriteAt > 250 && lastWrittenKmh > 0) {
    lastVerifyAt = now;
    const rb = await l.readRegisterFast(0x16, 0x48, 2, 150);
    if (rb != null) {
      const actual = SpeedMap.kmhFromRaw(le16(rb));
      if (actual !== lastWrittenKmh) {
        verifyMismatch++;
        if (verifyMismatch >= 2) {
          useAckWrites = true;
          log(`[assist] Schnell-Schreiben kommt nicht an (Roller meldet ${actual} statt ${lastWrittenKmh} km/h) - wechsle auf bestaetigtes Schreiben (langsamer)`);
        }
      } else {
        verifyMismatch = 0;
      }
    }
  }
}

/** Failsafe: Nach Verbindungsabbruch/Absturz das urspruengliche Limit wiederherstellen. */
async function maybeRestoreFailsafe() {
  const saved = prefs.get('failsafe');
  if (saved == null || saved < 0 || assistActive) return;
  const l = link;
  if (!l) return;
  if (!SpeedMap.inRange(saved)) {
    prefs.set('failsafe', -1);
    return;
  }
  const r = await l.setSpeed(saved, calibration());
  if (r.type === 'Applied') {
    prefs.set('failsafe', -1);
    log(`[failsafe] Limit auf ${saved} km/h wiederhergestellt (vorheriger Abbruch)`);
  } else {
    log('[failsafe] Wiederherstellen nicht bestaetigt - neuer Versuch beim naechsten Verbinden');
  }
}

/* --------------------------------------------------------------- Slider */
dom.modeGroup?.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
  if (assistActive) {
    log('[mode] nur bei gestopptem Assistenten umschaltbar');
    return;
  }
  wheelieMode = parseInt(b.dataset.mode, 10);
  prefs.set('mode', wheelieMode);
  updateModeUi();
}));
dom.presetGroup?.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
  prefs.set('preset', parseInt(b.dataset.p, 10));
  reloadWheelieConfig();
  updateModeUi();
}));

const bindDe = (el, out, key, parse = parseFloat, fmtFn = (v) => v) => {
  if (!el) return;
  const cur = prefs.get(key);
  el.value = String(cur);
  if (out) out.textContent = fmtFn(cur);
  el.addEventListener('input', () => {
    const v = parse(el.value);
    prefs.set(key, v);
    if (out) out.textContent = fmtFn(v);
    reloadWheelieConfig();
    if (key === 'target') {
      dom.outTarget.textContent = String(wheelie.targetDeg);
      el.value = String(wheelie.targetDeg);
    }
  });
};
bindDe(dom.sliderTarget, dom.outTarget, 'target', parseInt, (v) => String(v));
bindDe(dom.sliderWSpeed, dom.outWSpeed, 'wSpeed', parseInt, (v) => String(v));
bindDe(dom.sliderAnti, dom.outAnti, 'anti', parseInt, (v) => String(v));
bindDe(dom.sliderMin, dom.outMin, 'rangeMin', parseInt, (v) => String(v));
bindDe(dom.sliderMax, dom.outMax, 'rangeMax', parseInt, (v) => String(v));
bindDe(dom.sliderKp, dom.outKp, 'kp');
bindDe(dom.sliderDb, dom.outDb, 'db');
bindDe(dom.sliderRamp, dom.outRamp, 'ramp', parseInt, (v) => String(v));
bindDe(dom.sliderDrop, dom.outDrop, 'drop', parseInt, (v) => String(v));
bindDe(dom.sliderTol, dom.outTol, 'tol', parseInt, (v) => String(v));

dom.speedSource?.addEventListener('change', () => {
  prefs.set('speedSource', parseInt(dom.speedSource.value, 10));
  assistSpeedSource = prefs.get('speedSource');
});
dom.chkTts?.addEventListener('change', () => prefs.set('tts', dom.chkTts.checked));

/* ---------------------------------------------------------- Krypto-Selbsttest */
dom.btnSelftest?.addEventListener('click', runSelftest);

const keyScheduleStable = () => aes128KeySchedule(fromHex('000102030405060708090a0b0c0d0e0f'));
const aesBlock = (block, rk) => aesEncryptBlock16(block, rk);

async function runSelftest() {
  dom.btnSelftest.disabled = true;
  dom.selftestResult.textContent = 'läuft …';
  try {
    const results = [];
    const check = (name, ok, detail = '') => {
      results.push(ok);
      log(`${ok ? '[test] OK  ' : '[test] FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
    };

    // 1) AES-128-Kanonvektor (FIPS-197, Appendix C.1)
    const rk = keyScheduleStable();
    const ct = toHex(aesBlock(fromHex('00112233445566778899aabbccddeeff'), rk));
    check('AES-128 FIPS-Vektor', ct === '69c4e0d86a7b0430d8cdb78070b4c55a', ct);

    // 2) NbCrypto-Vektoren (aus NbCryptoTest.kt, Python-Referenz)
    const name = latin1('1EFHG2603C2222');
    const ble = fromHex('51d598844435934c958a3fa13e33dc6b');
    const app = fromHex('2990ab7909b4591476bc57ef4fa00d68');

    const cryptoBle = await makeCrypto(name, ble, null, 1);
    {
      // Frame.propose-Baugleich: Kopf + app_random
      const frame = concatBytes(fromHex('5aa5103e045c00'), app);
      const enc = cryptoBle.encrypt(frame);
      check('encrypt(ble,ctr=1) propose', toHex(enc) === '5aa510deb95bea9fcc0f6eea574acc319c0c42375289b101b049500002', toHex(enc));
      check('counter nach encrypt=2', cryptoBle.counter === 2, String(cryptoBle.counter));
    }

    const cApp2 = await makeCrypto(name, ble, app, 2);
    {
      const plain = fromHex('5aa50e3e045d003145464847323630334332323232');
      const enc = cApp2.encrypt(plain);
      check('encrypt(app,ctr=2) accept', toHex(enc) === '5aa50e04e623dc94a2d9f18fbb65551549784da5b1872ee40c0003', toHex(enc));
      check('counter accept=3', cApp2.counter === 3, String(cApp2.counter));
    }

    const cApp2b = await makeCrypto(name, ble, app, 2);
    {
      const plain = fromHex('5aa5013e16014802');
      const enc = cApp2b.encrypt(plain);
      check('encrypt(app,ctr=2) read 0x48', toHex(enc) === '5aa50104f47f94a73740022d0003', toHex(enc));
    }

    const cApp4 = await makeCrypto(name, ble, app, 4);
    {
      const plain = fromHex('5aa502163e04480016');
      const enc = cApp4.encrypt(plain);
      check('encrypt(app,ctr=4) write 0x16FF', toHex(enc) === '5aa50293742d8cccaa946ee0ef0005', toHex(enc));
      check('counter write=5', cApp4.counter === 5, String(cApp4.counter));
    }

    // 3) RX-Entschluesselung (0x5C/01 Button-Bestaetigung, BLE-Key!)
    const cDec = await makeCrypto(name, ble, null, 0);
    {
      const plain = cDec.decrypt(fromHex('5aa500e4835beb87b10d720002'));
      const ok = toHex(plain).startsWith('5aa500043e5c01') && cDec.counter === 2;
      check('decrypt 5C/01', ok, `${toHex(plain)}, counter=${cDec.counter}`);
    }

    // 4) counter==0 (BLE-Key wie Kotlin-Test): Groesse plain+6, Footer 00 00 crc16(LE) 00 00, Roundtrip
    const c0 = await makeCrypto(name, ble, null, 0);
    {
      const frame = fromHex('5aa5003e045b00');
      const enc = c0.encrypt(frame);
      const sizeOk = enc.length === frame.length + 6;
      const footer = toHex(enc.slice(-6));
      const roundtrip = toHex(c0.decrypt(enc)) === toHex(frame);
      check('counter==0 Groesse', sizeOk, String(enc.length));
      check('counter==0 Footer', footer.startsWith('0000') && footer.endsWith('0000'), footer);
      check('Roundtrip decrypt', roundtrip);
    }

    // 5) SpeedMap
    check('SpeedMap rawForKmh', SpeedMap.rawForKmh(22) === 22 << 8 && SpeedMap.kmhFromRaw(0x16FF) === 22);
    check('SpeedMap Kalibrier prio', SpeedMap.rawForKmh(22, { 22: 0x1500 }) === 0x1500);

    const fails = results.filter((x) => !x).length;
    if (fails === 0) {
      dom.selftestResult.textContent = `✅ ${results.length}/${results.length} Tests bestanden`;
      dom.selftestResult.style.color = '';
      log(`[test] alle ${results.length} Krypto-Tests bestanden (AES-ECB + NbCrypto + SpeedMap)`);
    } else {
      dom.selftestResult.textContent = `❌ ${fails}/${results.length} fehl (Details im Protokoll)`;
      dom.selftestResult.style.color = 'var(--warn)';
    }
  } catch (e) {
    dom.selftestResult.textContent = `❌ Fehler: ${e.message}`;
    dom.selftestResult.style.color = 'var(--warn)';
    log(`[test] Ausnahmefehler: ${e.message}`);
  } finally {
    dom.btnSelftest.disabled = false;
  }
}

async function makeCrypto(name, ble, app, ctr) {
  const c = new NbCrypto();
  await c.setName(name);
  await c.setBleData(ble);
  if (app) await c.setAppData(app);
  c.counter = ctr;
  return c;
}

function concatBytes(...arrs) {
  let n = 0;
  for (const a of arrs) n += a.length;
  const out = new Uint8Array(n);
  let i = 0;
  for (const a of arrs) { out.set(a, i); i += a.length; }
  return out;
}

/* --------------------------------------------------------------- Start */
function initPanicRestoreOnLeave() { window.addEventListener('pagehide', resetPanicOnNavigate); }

function init() {
  // Prefs auf die Steuerelemente spiegeln
  dom.serialInput.value = prefs.get('deviceName') ?? '';
  dom.btnVoice.disabled = false;
  dom.chkWake.checked = !!prefs.get('wake');
  dom.chkTts.checked = prefs.get('tts') !== false;
  dom.speedSource.value = String(prefs.get('speedSource') ?? 1);
  link.nameHint = dom.serialInput.value.trim();

  loadCalibration();
  reloadWheelieConfig();
  updateKeyInfo();
  dom.speedText.textContent = 'Max-Speed (0x48): –';
  log('[start] ScooVoice Web bereit. Verbinden: Chrome/Edge, dann Power-Button beim Erst-Pairing drücken.');
  if (!('bluetooth' in navigator)) {
    log('[!] Web Bluetooth fehlt in diesem Browser (Chrome/Edge/desktop bzw. Android-Chrome; iOS/Safari nein).');
    dom.btnConnect.disabled = true;
  }
  // Takt fuer Kalibrier-Anzeige nur, sobald Kalibrieren/Assistent benutzt wird.
  pushTiltUi(nowMs(), true);
  initPanicRestoreOnLeave();
}
init();
