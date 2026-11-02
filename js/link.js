/**
 * ScooVoice Web – BLE-Sitzung (Port von ScooterLink.kt auf Web Bluetooth)
 *
 * Ablauf pro Verbindung (dokumentiert in docs/PROTOKOLL.md der Android-App):
 *   1. 0x5B Identify (Counter 0, FW-Key) -> RX enthält ble(16) + serial(14).
 *   2. Fast-Re-Pair mit gespeichertem app_random: 0x5D zweimal (Counter 0 und 1).
 *   3. Sonst 0x5C ×4 Proposal (BLE-Key, jeder Frame On-Air-Counter 2,
 *      Abstände [83, 627, 1154, 1695] ms) -> 25 s auf 0x5C/01 warten (Power-Button).
 *   4. 0x5D Accept (APP-Key) -> authentifiziert, Key sichern.
 *
 * Bewusste Abweichung wie in der Android-App: pro GATT-Verbindung frische Krypto
 * (FW-Key, Counter 0 = Zustand Erstverbindung).
 *
 * Web-Bluetooth-Besonderheiten: der Browser wählt das Gerät (requestDevice),
 * MTU lässt sich nicht anfragen -> Schreiben je Chunk 20 Bytes/5 ms bis der
 * Stack lange Writes nimmt (Aderptivmodus), Notify statt GATT-Callback.
 */
import { Frame, NbCrypto, RxStream, SpeedMap, concat, decrypt, fromLatin1, fromHex, latin1, toHex } from './protocol.js';

const NORDIC_SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const NUS_WRITE = '6e400002-b5a3-f393-e0a9-e50e24dcca9e';
const NUS_NOTIFY = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';
const PROPOSE_OFFSETS_MS = [83, 627, 1154, 1695];
const BUTTON_WINDOW_MS = 25_000;
const RETRY_DELAY_MS = 8_000;
const CHUNK = 20;
const CHUNK_DELAY_MS = 5;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class ScooterLink {
  constructor({ onLog = () => {}, onState = () => {}, onSession = () => {}, onRegister = () => {}, onAuthenticated = () => {} } = {}) {
    this.onLog = onLog;
    this.onState = onState;
    this.onSession = onSession;
    this.onRegister = onRegister;
    this.onAuthenticated = onAuthenticated;

    this.device = null;
    this.server = null;
    this.writeChar = null;
    this.crypto = null;
    this.buffer = new RxStream(null);

    this.serial = '';
    this.ble = new Uint8Array(0);
    this.appRandom = null;
    this.connected = false;
    this.authenticated = false;
    this.running = false;
    this.stopping = false;
    this.motor = 0; // 0 = einzelne Writes ok, 1 = gechunkt (Adaptive-Modus)
    this.frameQueue = [];
    this.linkMutex = Promise.resolve();
    this.nameHint = '';
  }

  /** Serialisierte IO-Kette (Pendant zur linkMutex aus ScooterLink.kt). */
  runExclusive(fn) {
    const p = this.linkMutex.then(fn);
    this.linkMutex = p.catch(() => {});
    return p;
  }

  state(s) { this.onState(s); }

  /* ------------------------------------------------------------ Steuerung */

  async startLoop() {
    if (this.running) return;
    this.running = true;
    this.stopping = false;
    while (this.running && !this.stopping) {
      try {
        await this.connectOnce();
      } catch (e) {
        this.onLog(`[!] Verbindung fehl: ${brief(e)}`);
      }
      if (this.running && !this.stopping) {
        this.state('retry');
        await sleep(RETRY_DELAY_MS);
      }
    }
  }

  stopLoop() {
    this.running = false;
    this.stopping = true;
    try { this.server?.disconnect(); } catch { /* egal */ }
    this.server = null;
    this.connected = false;
    this.authenticated = false;
    this.state('disconnected');
  }

  /* ------------------------------------------------- Verbindung + Handshake */

  /** Gerät im Browser-Picker wählen (Benutzer-Geste nötig). */
  async pickDevice() {
    const filters = [{ services: [NORDIC_SERVICE] }];
    try {
      this.device = await navigator.bluetooth.requestDevice({
        filters,
        optionalServices: [NORDIC_SERVICE],
      });
    } catch {
      // Name-Fallback, falls Filter-Scan keine Treffer liefert
      this.device = await navigator.bluetooth.requestDevice({
        filters: [{ namePrefix: '1EF' }],
        optionalServices: [NORDIC_SERVICE],
      });
    }
    const d = this.device;
    this.onLog(`[scan] ${d?.name ?? '(ohne Namen)'}`);
    return d;
  }

  async connectOnce() {
    this.authenticated = false;
    this.state('scan');
    if (!this.device) await this.pickDevice();
    if (!navigator.bluetooth || !this.device) { this.state('notfound'); return; }
    this.state('connecting');
    try {
      await this.connectGattAndPrepare();
      this.state('handshake');
      if (!await this.handshake()) {
        await this.closeGatt();
        this.state('handshake-failed');
        return;
      }
      this.state('authenticated');
      this.onAuthenticated();
      // bis zum Verbindungsverlust warten (Reconnect im Loop)
      await this.waitDisconnected();
      await this.closeGatt();
      this.state('disconnected');
    } finally {
      this.buffer = new RxStream(null); // Buffer frisch pro Versuch
    }
  }

  async connectGattAndPrepare() {
    this.onLog('[*] verbinde ...');
    const serverPromise = this.device.gatt.connect();
    const server = await withTimeout(serverPromise, 40_000, 'Verbindungsaufbau timeout');
    this.server = server;
    this.connected = true;
    this.onLog('[+] GATT verbunden - Services suchen');
    const svc = await withTimeout(server.getPrimaryService(NORDIC_SERVICE), 15_000, 'Service fehlt');
    this.writeChar = await withTimeout(svc.getCharacteristic(NUS_WRITE), 15_000, 'Write-Char fehlt');
    const notify = await withTimeout(svc.getCharacteristic(NUS_NOTIFY), 15_000, 'Notify-Char fehlt');

    this.crypto = new NbCrypto();
    this.buffer = new RxStream((raw) => this.deliver(raw));

    await withTimeout(notify.startNotifications(), 15_000, 'Notify aktivieren fehl');
    notify.addEventListener('characteristicvaluechanged', (ev) => {
      this.buffer.onFrameData(new Uint8Array(ev.target.value.buffer ?? ev.target.value));
    });
    server.addEventListener('gattserverdisconnected', () => {
      this.connected = false;
      this.disconnectedWave?.();
    });
    this.onLog('[+] Notify aktiviert - Session-Aufbau startet');
  }

  waitDisconnected() {
    return new Promise((resolve) => { this.disconnectedWave = resolve; });
  }

  /** Der Name (Seriennummer) ist die Basis des Keys; ohne Namen Fallback-Feld. */
  async handshake() {
    const name = (this.device?.name || this.nameHint || '').trim();
    if (!name) throw new Error('Gerät ohne Namen - Seriennummer unten eintragen');
    await this.crypto.setName(latin1(name));
    if (!await this.identity()) return false;

    const saved = name ? this.keyProvider?.(name) : null; // {hex} oder null
    if (saved) {
      this.onLog('[2/4] Fast-Re-Pair mit gespeichertem Key (ohne Button) probiert');
      if (await this.fastRepair(saved)) return true;
      this.onLog('[..] Fast-Re-Pair abgelehnt - voller Handshake folgt, danach Power-Button');
    }
    if (!await this.propose()) return false;
    if (!await this.waitButton()) return false;
    return await this.accept();
  }

  async identity() {
    this.state('identity');
    this.clearFrames();
    await this.writeFrames(Frame.identity());
    await sleep(700);
    const f = this.frameQueue.find((x) => x.cmd === 0x5b && x.data.length >= 30);
    if (!f || !f.data) { this.onLog('[!] keine 0x5B-Antwort'); return false; }
    this.ble = f.data.slice(0, 16);
    this.serial = fromLatin1(f.data.slice(16, 30)).replace(/[\0 ]+/g, '').trim();
    this.onLog(`[+] Seriennummer: ${this.serial}`);
    return true;
  }

  async fastRepair(savedHex) {
    this.state('fast-repair');
    const saved = fromHex(savedHex);
    for (const attempt of [0, 1]) {
      // wie main.py: erst BLE-, dann APP-Key setzen, dann Counter setzen
      await this.crypto.setBleData(this.ble);
      await this.crypto.setAppData(saved);
      this.crypto.counter = attempt;
      this.clearFrames();
      await this.writeFrames(Frame.accept(this.serial));
      await sleep(1_200);
      if (this.frameQueue.some((x) => x.cmd === 0x5d && x.index === 0x01)) {
        this.appRandom = saved;
        this.authenticated = true;
        this.keySaver?.(this.serial, savedHex);
        this.onLog('[+] FAST RE-PAIR ERFOLGREICH - kein Button nötig');
        this.onSession(this.serial, savedHex);
        return true;
      }
      this.onLog(`[..] Versuch mit Counter=${attempt} abgelehnt`);
    }
    this.onLog('[!] gespeicherter Key abgelehnt - wird gelöscht (volles Pairing mit Button folgt)');
    this.keyClearer?.(this.serial);
    return false;
  }

  async propose() {
    this.state('propose');
    await this.crypto.setBleData(this.ble);
    this.appRandom = crypto.getRandomValues(new Uint8Array(16));
    const t0 = Date.now();
    for (const offset of PROPOSE_OFFSETS_MS) {
      const wait = t0 + offset - Date.now();
      if (wait > 0) await sleep(wait);
      this.crypto.counter = 1; // jeder 0x5C geht mit Counter 2 raus
      this.clearFrames();
      await this.writeFrames(Frame.propose(this.appRandom));
      this.crypto.counter = 1;
      await sleep(40);
      for (const f of this.drainFrames()) {
        this.onLog(`[RX] 0x${f.cmd.toString(16).padStart(2, '0')}/${f.index.toString(16).padStart(2, '0')}`);
      }
    }
    return this.connected;
  }

  async waitButton() {
    this.state('button_window');
    this.onLog(`[3/4] >>> POWER-BUTTON AM SCOOTER DRÜCKEN <<< (${Math.round(BUTTON_WINDOW_MS / 1000)} s Fenster)`);
    const deadline = Date.now() + BUTTON_WINDOW_MS;
    while (Date.now() < deadline) {
      if (this.frameQueue.some((x) => x.cmd === 0x5c && x.index === 0x01)) {
        this.onLog('[+] 0x5C/01 erhalten - Button bestätigt');
        return true;
      }
      if (!this.connected) { this.onLog('[!] Scooter neu gestartet - Button verpasst'); return false; }
      await sleep(200);
    }
    this.onLog('[!] keine Bestätigung (kein 0x5C/01)');
    return false;
  }

  async accept() {
    this.state('accept');
    await this.crypto.setAppData(this.appRandom);
    this.clearFrames();
    await this.writeFrames(Frame.accept(this.serial));
    await sleep(2_000);
    const ok = this.frameQueue.some((x) => x.cmd === 0x5d && x.index === 0x01);
    if (ok) {
      this.authenticated = true;
      this.keySaver?.(this.serial, toHex(this.appRandom));
      this.onLog('[4/4] AUTHENTIFIZIERT - Pairing-Key gesichert');
      this.onSession(this.serial, toHex(this.appRandom));
    } else {
      this.onLog('[!] 0x5D abgelehnt');
    }
    return ok;
  }

  /* ------------------------------------------------------------- RX-Kette */

  clearFrames() { this.frameQueue.length = 0; }
  drainFrames() { return this.frameQueue.splice(0); }

  deliver(rawBytes) {
    const f = decrypt(this.crypto, rawBytes);
    if (!f) {
      this.frameQueue.push({ cmd: -1, index: -1, data: new Uint8Array(0), raw: rawBytes });
      return;
    }
    this.frameQueue.push(f);
    // Ringpuffer: 0x04-Antworten bleiben zum Pollen liegen, aber nie unbegrenzt
    if (this.frameQueue.length > 64) this.frameQueue.splice(0, this.frameQueue.length - 64);
    this.onLog(`[RX] 0x${f.cmd.toString(16).padStart(2, '0')}/${f.index.toString(16).padStart(2, '0')} ${toHex(f.data)}`);
    if (f.cmd === 0x04 && f.data.length >= 2) {
      const raw = f.data[0] | (f.data[1] << 8);
      this.onRegister(f.index, raw);
    }
  }

  /* ------------------------------------------------------------ TX-Schreiben */

  async writeFrames(plain) {
    const frame = this.crypto.encrypt(plain); // Counter-Steuerung wie im Android-Port
    await this.writeRaw(frame);
  }

  async writeRaw(frame) {
    if (!this.writeChar || !this.connected) throw new Error('keine Verbindung');
    if (this.motor === 0) {
      try {
        await singleWrite(this.writeChar, frame);
        return;
      } catch (e) {
        this.motor = 1; // Plattform will/geht zulange Writes nicht -> future gechunkt
        this.onLog('[-] langer Write nicht moeglich - schreibe jetzt 20-Bytes-Chunks');
      }
    }
    let allOk = true;
    let offset = 0;
    while (offset < frame.length) {
      const len = Math.min(CHUNK, frame.length - offset);
      try { await singleWrite(this.writeChar, frame.subarray(offset, offset + len)); }
      catch (e) { allOk = false; this.onLog(`[!] BLE-Schreiben fehl: ${brief(e)}`); }
      offset += len;
      if (offset < frame.length) await sleep(CHUNK_DELAY_MS);
    }
    if (!allOk) throw new Error('chunked write unvollständig');
  }

  async closeGatt() {
    try { this.server?.disconnect(); } catch { /* egal */ }
    this.server = null;
    this.connected = false;
  }

  /* ---------------------------------------------------------- Register-IO */

  async readRegister(board, reg, n = 2) {
    return this.runExclusive(async () => {
      if (!this.authenticated || !this.connected) {
        this.onLog('[!] nicht verbunden/authentifiziert - Register-Leseanfrage ausgelassen');
        return null;
      }
      this.clearFrames();
      await this.writeFrames(Frame.read(board, reg, n));
      await sleep(250);
      const hit = this.drainFrames().filter((x) => x.cmd === 0x04 && x.index === reg && x.data.length >= n).pop();
      return hit ? hit.data.slice(0, n) : null;
    });
  }

  /** Schreiben (mit ACK), danach Rücklesen - wie die PC-Kalibrierung (Teil 1). */
  async writeRegisterWithAck(board, reg, data) {
    return this.runExclusive(async () => {
      if (!this.authenticated || !this.connected) return [false, null];
      this.clearFrames();
      await this.writeFrames(Frame.write(board, reg, data));
      await sleep(400);
      const ack = this.drainFrames().some((x) => x.cmd === 0x05);
      let readback = null;
      if (ack) {
        this.clearFrames();
        await this.writeFrames(Frame.read(board, reg, data.length));
        await sleep(200);
        const hit = this.drainFrames().filter((x) => x.cmd === 0x04 && x.index === reg && x.data.length >= data.length).pop();
        readback = hit ? hit.data.slice(0, data.length) : null;
      }
      return [ack, readback];
    });
  }

  /** Max-Speed setzen; Rücklesen prüft das Highbyte (Kalibrier-Formel). */
  async setSpeed(kmh, calibration) {
    if (!SpeedMap.inRange(kmh)) throw new RangeError(`km/h ${kmh} außerhalb 10..35`);
    const raw = SpeedMap.rawForKmh(kmh, calibration);
    const [ack, rb] = await this.writeRegisterWithAck(0x16, 0x48, le2(raw));
    if (!ack) return { type: 'NoAck' };
    const readbackRaw = rb ? (rb[0] | (rb[1] << 8)) : null;
    if (readbackRaw == null) return { type: 'NoAck' };
    return SpeedMap.kmhFromRaw(readbackRaw) === kmh
      ? { type: 'Applied', raw, readbackRaw }
      : { type: 'Mismatch', raw, readbackRaw };
  }

  /** Max-Speed OHNE ACK und ohne Rücklesen schreiben (cmd 0x03, wie setSpeedFast). */
  async setSpeedFast(kmh, calibration) {
    if (!SpeedMap.inRange(kmh)) throw new RangeError(`km/h ${kmh} außerhalb 10..35`);
    const raw = SpeedMap.rawForKmh(kmh, calibration);
    return this.runExclusive(async () => {
      try {
        if (!this.authenticated || !this.connected) return false;
        await this.writeFrames(Frame.write(0x16, 0x48, le2(raw), 0x03));
        return true;
      } catch { return false; }
    });
  }

  /** Schnelles Lesen: Anfrage senden (kurz unter Sperre), dann ohne Sperre Pollen. */
  async readRegisterFast(board, reg, n = 2, timeoutMs = 150) {
    const sent = await this.runExclusive(async () => {
      try {
        if (!this.authenticated || !this.connected) return false;
        this.clearFrames();
        await this.writeFrames(Frame.read(board, reg, n));
        return true;
      } catch { return false; }
    });
    if (!sent) return null;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const hit = this.frameQueue.filter((x) => x.cmd === 0x04 && x.index === reg && x.data.length >= n).pop();
      if (hit) return hit.data.slice(0, n);
      await sleep(1);
    }
    return null;
  }
}

export const brief = (e) => (e?.message || String(e)).slice(0, 80);

function singleWrite(char, bytes) {
  const view = bytes.buffer ? new Uint8Array(bytes).buffer : bytes;
  if (typeof char.writeValueWithoutResponse === 'function') {
    return char.writeValueWithoutResponse(view).catch((e) => { throw e; });
  }
  return char.writeValue(view);
}

const le2 = (v) => new Uint8Array([v & 0xFF, (v >>> 8) & 0xFF]);

async function withTimeout(promise, ms, msg) {
  let timer;
  const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(msg)), ms); });
  try { return await Promise.race([promise, timeout]); } finally { clearTimeout(timer); }
}
