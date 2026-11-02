/* ScooVoice Web – Protokollschicht
 *
 * Byte-exakte Portierung von Frame.kt und NbCrypto.kt (1:1 aus miauth/nb/nbcrypto.py),
 * plus SpeedMap.kt als Konstantenobjekt. Cryptocore: eigene AES-128-ECB-Implementierung
 * (WebCrypto kennt kein ECB) + SHA-1 via WebCrypto (async, nur beim Key-Setup).
 *
 * Frames[counter==0]: AES-Stream = konstant AES(FW_DATA) unter SHA1(name||FW_DATA),
 *   Footer = 00 00 crc16(payload) LE 00 00.
 * Frames[counter>0]: Stream-Block = AES([0x01][ctr u32 BE][ble[0..7]][0x00], [15] je Block +1),
 *   Footer = 4-Byte-AES-Kette + ctr (2 Bytes BE).
 * Der Counter wird IMMER aus dem RX-Footer übernommen; encrypt() schreibt
 * (counter + 1) in den Footer und erhöht sodann selbst (wie self.it in Python).
 */

export const fromHex = (s) => {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(2 * i, 2), 16);
  return out;
};
export const toHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

export const concat = (...arrs) => {
  let n = 0; for (const a of arrs) n += a.length;
  const out = new Uint8Array(n); let i = 0;
  for (const a of arrs) { out.set(a, i); i += a.length; }
  return out;
};

export const latin1 = (s) => {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xFF;
  return out;
};
export const fromLatin1 = (b) => {
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return s;
};

export function crc16Bytes(arr) {
  let sum = 0;
  for (const b of arr) sum += b & 0xFF;
  const n = (~sum >>> 0) & 0xFFFF;
  return new Uint8Array([n & 0xFF, n >>> 8]);
}
const crc16 = (arr) => {
  const b = crc16Bytes(arr);
  return b[0] | (b[1] << 8);
};

/* ------------------------------------------------------------ AES-128 ECB
 * AES-128-ECB (FIPS-197): Verschlüsselung eines 16-Byte-Blocks.
 */
const SBOX = new Uint8Array([
  0x63,0x7c,0x77,0x7b,0xf2,0x6b,0x6f,0xc5,0x30,0x01,0x67,0x2b,0xfe,0xd7,0xab,0x76,
  0xca,0x82,0xc9,0x7d,0xfa,0x59,0x47,0xf0,0xad,0xd4,0xa2,0xaf,0x9c,0xa4,0x72,0xc0,
  0xb7,0xfd,0x93,0x26,0x36,0x3f,0xf7,0xcc,0x34,0xa5,0xe5,0xf1,0x71,0xd8,0x31,0x15,
  0x04,0xc7,0x23,0xc3,0x18,0x96,0x05,0x9a,0x07,0x12,0x80,0xe2,0xeb,0x27,0xb2,0x75,
  0x09,0x83,0x2c,0x1a,0x1b,0x6e,0x5a,0xa0,0x52,0x3b,0xd6,0xb3,0x29,0xe3,0x2f,0x84,
  0x53,0xd1,0x00,0xed,0x20,0xfc,0xb1,0x5b,0x6a,0xcb,0xbe,0x39,0x4a,0x4c,0x58,0xcf,
  0xd0,0xef,0xaa,0xfb,0x43,0x4d,0x33,0x85,0x45,0xf9,0x02,0x7f,0x50,0x3c,0x9f,0xa8,
  0x51,0xa3,0x40,0x8f,0x92,0x9d,0x38,0xf5,0xbc,0xb6,0xda,0x21,0x10,0xff,0xf3,0xd2,
  0xcd,0x0c,0x13,0xec,0x5f,0x97,0x44,0x17,0xc4,0xa7,0x7e,0x3d,0x64,0x5d,0x19,0x73,
  0x60,0x81,0x4f,0xdc,0x22,0x2a,0x90,0x88,0x46,0xee,0xb8,0x14,0xde,0x5e,0x0b,0xdb,
  0xe0,0x32,0x3a,0x0a,0x49,0x06,0x24,0x5c,0xc2,0xd3,0xac,0x62,0x91,0x95,0xe4,0x79,
  0xe7,0xc8,0x37,0x6d,0x8d,0xd5,0x4e,0xa9,0x6c,0x56,0xf4,0xea,0x65,0x7a,0xae,0x08,
  0xba,0x78,0x25,0x2e,0x1c,0xa6,0xb4,0xc6,0xe8,0xdd,0x74,0x1f,0x4b,0xbd,0x8b,0x8a,
  0x70,0x3e,0xb5,0x66,0x48,0x03,0xf6,0x0e,0x61,0x35,0x57,0xb9,0x86,0xc1,0x1d,0x9e,
  0xe1,0xf8,0x98,0x11,0x69,0xd9,0x8e,0x94,0x9b,0x1e,0x87,0xe9,0xce,0x55,0x28,0xdf,
  0x8c,0xa1,0x89,0x0d,0xbf,0xe6,0x42,0x68,0x41,0x99,0x2d,0x0f,0xb0,0x54,0xbb,0x16,
]);
const RCON = new Uint8Array([0x01,0x02,0x04,0x08,0x10,0x20,0x40,0x80,0x1b,0x36]);

const xtime = (a) => ((a << 1) ^ ((a & 0x80) ? 0x1b : 0)) & 0xFF;
const mul2 = xtime;
const mul3 = (a) => (xtime(a) ^ a) & 0xFF;

/** Rundenschlüssel für AES-128: 11 × 16 Bytes = 176 Bytes. */
export function aes128KeySchedule(key16) {
  const w = new Uint8Array(176);
  w.set(key16.subarray(0, 16), 0);
  let rconIdx = 0;
  for (let i = 16; i < 176; i += 4) {
    const t = new Uint8Array(4);
    t.set(w.subarray(i - 4, i));
    if (i % 16 === 0) {
      t.set([t[1], t[2], t[3], t[0]]); // RotWord
      t[0] = SBOX[t[0]]; t[1] = SBOX[t[1]]; t[2] = SBOX[t[2]]; t[3] = SBOX[t[3]]; // SubWord
      t[0] ^= RCON[rconIdx++];
    }
    for (let k = 0; k < 4; k++) w[i + k] = w[i - 16 + k] ^ t[k];
  }
  return w;
}

/** AES-128-ECB-Verschlüsselung eines 16-Byte-Blocks (kanonisch, FIPS-197). */
export function aesEncryptBlock16(input, roundKeys) {
  const s = Uint8Array.from(input); // State in natürlicher Byte-Reihenfolge (Spalten auffüllend)
  const addRoundKey = (rk) => {
    for (let i = 0; i < 16; i++) s[i] ^= roundKeys[rk * 16 + i];
  };
  const subShift = () => {
    // SubBytes (byteweise) + ShiftRows: Zeile r wandert um r nach links
    for (let r = 0; r < 4; r++) {
      const row = [s[r], s[r + 4], s[r + 8], s[r + 12]];
      for (let c = 0; c < 4; c++) s[r + 4 * c] = SBOX[row[(c + r) % 4]];
    }
  };
  const mixColumns = () => {
    for (let c = 0; c < 4; c++) {
      const i = 4 * c;
      const a0 = s[i], a1 = s[i + 1], a2 = s[i + 2], a3 = s[i + 3];
      s[i] = mul2(a0) ^ mul3(a1) ^ a2 ^ a3;
      s[i + 1] = a0 ^ mul2(a1) ^ mul3(a2) ^ a3;
      s[i + 2] = a0 ^ a1 ^ mul2(a2) ^ mul3(a3);
      s[i + 3] = mul3(a0) ^ a1 ^ a2 ^ mul2(a3);
    }
  };
  addRoundKey(0);
  for (let round = 1; round <= 9; round++) {
    subShift();
    mixColumns();
    addRoundKey(round);
  }
  subShift();
  addRoundKey(10); // letzte Runde ohne MixColumns
  return s;
}

const keyCache = new Map();
const expand = (key16) => {
  const id = toHex(key16);
  let rk = keyCache.get(id);
  if (!rk) { rk = aes128KeySchedule(key16); keyCache.set(id, rk); }
  return rk;
};

/* ------------------------------------------------------------------ SHA-1 */
export async function sha1(bytes) {
  const d = await crypto.subtle.digest('SHA-1', bytes);
  return new Uint8Array(d);
}

/** sha1(16 || 16)[:16] – wie NbCrypto.sha1KeyOf. */
export async function sha1KeyOf(b1, b2) {
  const data = new Uint8Array(32);
  data.set(b1.subarray(0, Math.min(16, b1.length)), 0);
  data.set(b2.subarray(0, Math.min(16, b2.length)), 16);
  const h = await sha1(data);
  return h.slice(0, 16);
}

/* --------------------------------------------------------------- cryptoNext */

export const FW_DATA = fromHex('97cfb802844143de56002b3b34780a5d');

function xorBytes(d1, d2, size) {
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i++) out[i] = (d1[i] ^ d2[i]) & 0xFF;
  return out;
}

/** Port von NbCrypto.crc_next: ohne Key/Stream = crc16; sonst AES-Kette + letzte 4 XOR AES(aesData[0]=1,[15]=0). */
function crcNext(data, keyVec, aes, roundKeys) {
  if (!keyVec && !aes) return new Uint8Array(crc16Bytes(data));
  let aesKey = aesEncryptBlock16(aes, roundKeys);

  // Block 1: Header (3 Bytes, mit Nullen aufgefüllt) XOR Saat, dann AES
  const headerBlock = new Uint8Array(16);
  headerBlock.set(data.subarray(0, Math.min(3, data.length)));
  aesKey = aesEncryptBlock16(xorBytes(headerBlock, aesKey, 16), roundKeys);

  const xorData2 = new Uint8Array(aesKey);
  let xorData1 = new Uint8Array(16);

  let plLen = data.length - 3;
  let byteIdx = 3;
  while (plLen > 0) {
    const tmpLen = plLen <= 16 ? plLen : 16;
    xorData1 = new Uint8Array(16);
    xorData1.set(data.subarray(byteIdx, byteIdx + tmpLen));
    const xored = xorBytes(xorData1, xorData2, 16);
    aesKey = aesEncryptBlock16(xored, roundKeys);
    xorData2.set(aesKey);
    plLen -= tmpLen;
    byteIdx += tmpLen;
  }

  aes[0] = 1;
  aes[15] = 0;
  aesKey = aesEncryptBlock16(aes, roundKeys);
  xorData1.set(aesKey.subarray(0, 4));
  return xorBytes(xorData1, xorData2, 4);
}

/** Port von crypto_next: einheitliche Block-Stream-XOR-Nutzung; mutiert aesData wie das Original ([15] += 1 je Block). */
function cryptoNext(inp, keyVec, aesData, roundKeys) {
  const result = new Uint8Array(inp.length);
  let byteIdx = 0;
  let plLen = inp.length;
  while (plLen > 0) {
    const tmpLen = plLen <= 16 ? plLen : 16;
    const block = new Uint8Array(16);
    block.set(inp.subarray(byteIdx, byteIdx + tmpLen));

    let aesKey;
    if (!aesData) {
      aesKey = aesEncryptBlock16(FW_DATA, roundKeys);
    } else {
      aesData[15] = (aesData[15] + 1) & 0xFF;
      aesKey = aesEncryptBlock16(aesData, roundKeys);
    }
    const xored = xorBytes(block, aesKey, 16);
    result.set(xored.subarray(0, tmpLen), byteIdx);
    plLen -= tmpLen;
    byteIdx += tmpLen;
  }
  return result;
}

/* ----------------------------------------------------------------- NbCrypto */
export class NbCrypto {
  constructor() {
    this.name = new Uint8Array(0);
    this.key = new Uint8Array(16);
    this.bleData = null;
    this.appData = null;
    this.counter = 0;
    this.ready = false;
  }

  async setName(nameBytes) {
    this.name = nameBytes.slice();
    this.key = await sha1KeyOf(this.name, FW_DATA);
    this.ready = true;
  }
  async setBleData(ble) {
    this.bleData = ble.slice();
    this.key = await sha1KeyOf(this.name, this.bleData);
  }
  async setAppData(app) {
    this.appData = app.slice();
    this.key = await sha1KeyOf(this.appData, this.bleData ?? new Uint8Array(0));
  }

  genAesData() {
    const aes = new Uint8Array(16);
    aes[0] = 1;
    aes[1] = (this.counter >>> 24) & 0xFF;
    aes[2] = (this.counter >>> 16) & 0xFF;
    aes[3] = (this.counter >>> 8) & 0xFF;
    aes[4] = this.counter & 0xFF;
    const ble = this.bleData ?? new Uint8Array(0);
    aes.set(ble.subarray(0, Math.min(8, ble.length)), 5);
    aes[15] = 0;
    return aes;
  }

  encrypt(data) {
    const rk = expand(this.key);
    const plLen = data.length - 3;
    const pl = data.slice(3);
    let out;
    if (this.counter === 0) {
      // Initialzustand (0x5B): FW-Stream + crc16-Footer
      const crc = crc16Bytes(pl);
      const enc = cryptoNext(pl, this.key, null, rk);
      out = new Uint8Array(plLen + 9);
      out.set(data.subarray(0, 3), 0);
      out.set(enc, 3);
      out[plLen + 3] = 0;
      out[plLen + 4] = 0;
      out[plLen + 5] = crc[0];
      out[plLen + 6] = crc[1];
      out[plLen + 7] = 0;
      out[plLen + 8] = 0;
    } else {
      this.counter += 1;
      const aesData = this.genAesData();
      const enc = cryptoNext(pl, this.key, aesData, rk);
      // CRC-Kette stellt genau wie in Python ein überlagertes aes_data her:
      aesData[0] = 0x59;
      aesData[15] = plLen & 0xFF;
      const crc = crcNext(data, this.key, aesData, rk);
      out = new Uint8Array(plLen + 9);
      out.set(data.subarray(0, 3), 0);
      out.set(enc, 3);
      out[plLen + 3] = crc[0];
      out[plLen + 4] = crc[1];
      out[plLen + 5] = crc[2];
      out[plLen + 6] = crc[3];
      out[plLen + 7] = (this.counter >>> 8) & 0xFF;
      out[plLen + 8] = this.counter & 0xFF;
    }
    return out;
  }

  decrypt(data) {
    const rk = expand(this.key);
    const plLen = data.length - 9;
    const out = new Uint8Array(plLen + 3);
    out.set(data.subarray(0, 3), 0);
    // Counter aus dem RX-Footer (letzte 2 Bytes, Big-Endian) übernehmen –
    // das ist, wie in Python, der Synchronisationsmechanismus.
    this.counter = ((data[data.length - 2] & 0xFF) << 8) | (data[data.length - 1] & 0xFF);
    const pl = data.slice(3, 3 + plLen);
    const dec = this.counter === 0
      ? cryptoNext(pl, this.key, null, rk)
      : cryptoNext(pl, this.key, this.genAesData(), rk);
    out.set(dec, 3);
    return out;
  }
}

export const decrypt = (crypto, raw) => {
  let plain;
  try { plain = crypto.decrypt(raw); } catch { return null; }
  if (plain.length < 7) return null;
  const cmd = plain[5];
  const index = plain[6];
  const data = plain.slice(7);
  return { cmd, index, data, raw: plain };
};

/* ------------------------------------------------------------------ Frames */
export const Frame = {
  identity() {
    return new Uint8Array([0x5a, 0xa5, 0x00, 0x3e, 0x04, 0x5b, 0x00]);
  },
  propose(appRandom) {
    if (appRandom.length !== 16) throw new Error('app_random muss 16 Bytes haben');
    const head = new Uint8Array([0x5a, 0xa5, 0x10, 0x3e, 0x04, 0x5c, 0x00]);
    return concat(head, appRandom);
  },
  accept(serial) {
    const s = latin1(serial);
    const head = new Uint8Array([0x5a, 0xa5, 0x0e, 0x3e, 0x04, 0x5d, 0x00]);
    return concat(head, s);
  },
  read(board, reg, n) {
    return new Uint8Array([0x5a, 0xa5, 0x01, 0x3e, board, 0x01, reg, n]);
  },
  write(board, reg, data, cmd = 0x02) {
    const head = new Uint8Array([0x5a, 0xa5, data.length, 0x3e, board, cmd, reg]);
    return concat(head, data);
  },
};

/** Klartext-Frame-Aufbau: [5A A5 LEN SRC DST CMD IDX payload] – wie Frame.kt. */

/* --------------------------------------------------------------- RX-Stream */
export class RxStream {
  constructor(onFrame) {
    this.onFrame = onFrame;
    this.buffer = new Uint8Array(0);
  }

  /** Notify-Bytes empfangen, Luft-Rohstream parsen (wie main.py on_data / ScooterLink.onFrameData). */
  onFrameData(value) {
    if (!value || value.length === 0) return;
    this.buffer = concat(this.buffer, value);
    let discarded = 0;
    while (this.buffer.length - discarded >= 3) {
      const start = findHeader(this.buffer, discarded);
      if (start < 0) { this.buffer = new Uint8Array(0); return; }
      discarded = start;
      const total = (this.buffer[discarded + 2] & 0xFF) + 13;
      if (this.buffer.length - discarded < total) {
        this.buffer = this.buffer.slice(discarded);
        return;
      }
      const frameBytes = this.buffer.slice(discarded, discarded + total);
      discarded += total;
      this.onFrame(frameBytes);
    }
    this.buffer = this.buffer.slice(Math.min(discarded, this.buffer.length));
  }
}

function findHeader(b, from) {
  for (let i = from; i < b.length - 1; i++) {
    if (b[i] === 0x5a && b[i + 1] === 0xa5) return i;
  }
  return -1;
}

/* --------------------------------------------------------------- SpeedMap */
export const SpeedMap = {
  KMH_MIN: 10,
  KMH_MAX: 35,
  rawForKmh(kmh, calibration) {
    if (!SpeedMap.inRange(kmh)) throw new RangeError(`km/h ${kmh} außerhalb 10..35`);
    const known = calibration ? calibration[kmh] : undefined;
    return known != null ? known : (kmh << 8);
  },
  kmhFromRaw(raw) { return (raw >>> 8) & 0xFF; },
  inRange(kmh) { return kmh >= 10 && kmh <= 35; },
  parseCalibration(jsonText) {
    try {
      const root = JSON.parse(jsonText);
      const entries = root.entries || {};
      const out = {};
      for (const [key, entry] of Object.entries(entries)) {
        if (!entry || entry.verified !== true) continue;
        const raw = Number.isFinite(entry.raw) ? Math.trunc(entry.raw) : -1;
        const kmh = parseInt(key, 10);
        if (raw >= 0 && SpeedMap.inRange(kmh)) out[kmh] = raw;
      }
      return out;
    } catch { return {}; }
  },
};
