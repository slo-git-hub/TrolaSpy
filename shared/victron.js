// Victron "Instant readout": SmartSolar chargers and Orion Smart DC-DC chargers broadcast their
// live values over Bluetooth every second or so, encrypted with a per-device key (VictronConnect:
// the device's settings, Product info, Instant readout details). The TrolaSpy Bridge app on the
// tablet passes the raw broadcasts on; they are decrypted and read here.
//
// Broadcast (manufacturer data for Victron, company id 0x02E1):
//   0x10, ?, model id (u16 LE), record type (u8), counter (u16 LE), first key byte, encrypted record
// The record is AES-128-CTR, counter block = the counter as a 128-bit little-endian number.
// Fields are packed from the lowest bit up. Layout as in the victron-ble project.

export const RECORD = { SOLAR: 0x01, DCDC: 0x04 };

// VE.Direct device states (charge stages).
export const STATES = {
  0: 'Off', 1: 'Low power', 2: 'Fault', 3: 'Bulk', 4: 'Absorption', 5: 'Float', 6: 'Storage',
  7: 'Equalize', 9: 'Inverting', 11: 'Power supply', 245: 'Starting up', 246: 'Repeated absorption',
  247: 'Recondition', 248: 'Battery safe', 249: 'Active', 252: 'External control',
};

// Why a DC-DC charger is off (bit flags).
export const OFF_REASONS = {
  0x01: 'No input power', 0x02: 'Switched off', 0x04: 'Switched off', 0x08: 'Remote input',
  0x10: 'Protection active', 0x20: 'Out of credit', 0x40: 'BMS', 0x80: 'Engine off', 0x100: 'Checking input voltage',
};

const hexBytes = (hex) => {
  if (typeof hex !== 'string' || !/^([0-9a-f]{2})+$/i.test(hex)) return null;
  return Uint8Array.from(hex.match(/../g), (b) => parseInt(b, 16));
};

export function container(bytes) {
  if (!bytes || bytes.length < 9 || bytes[0] !== 0x10) return null;
  return {
    model: bytes[2] | (bytes[3] << 8),
    type: bytes[4],
    counter: bytes[5] | (bytes[6] << 8),
    keyCheck: bytes[7],
    data: bytes.slice(8),
  };
}

// AES-CTR whose counter block is little-endian: each 16-byte block gets its own counter block.
async function decrypt(keyBytes, counter, data) {
  const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-CTR', false, ['decrypt']);
  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i += 16) {
    const block = new Uint8Array(16);
    let n = counter + i / 16;
    for (let j = 0; j < 6 && n > 0; j++) { block[j] = n & 0xff; n = Math.floor(n / 256); }
    const part = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CTR', counter: block, length: 64 }, key, data.slice(i, i + 16)));
    out.set(part, i);
  }
  return out;
}

function bitReader(bytes) {
  let pos = 0;
  const u = (bits) => {
    let v = 0;
    for (let i = 0; i < bits; i++, pos++) {
      const byte = bytes[pos >> 3] ?? 0;
      v += ((byte >> (pos & 7)) & 1) * 2 ** i;
    }
    return v;
  };
  const s = (bits) => { const v = u(bits); return v >= 2 ** (bits - 1) ? v - 2 ** bits : v; };
  return { u, s };
}

const na = (v, missing, scale = 1) => (v === missing ? null : Math.round((v / scale) * 1000) / 1000);

export function parseSolar(bytes) {
  const r = bitReader(bytes);
  const state = r.u(8), error = r.u(8), volts = r.s(16), amps = r.s(16), yieldToday = r.u(16), power = r.u(16), load = r.u(9);
  return {
    state: na(state, 0xff), error: na(error, 0xff),
    batt_v: na(volts, 0x7fff, 100), batt_a: na(amps, 0x7fff, 10),
    yield_wh: yieldToday === 0xffff ? null : yieldToday * 10, pv_w: na(power, 0xffff),
    load_a: na(load, 0x1ff, 10),
  };
}

export function parseDcdc(bytes) {
  const r = bitReader(bytes);
  const state = r.u(8), error = r.u(8), inV = r.u(16), outV = r.s(16), off = r.u(32);
  return {
    state: na(state, 0xff), error: na(error, 0xff),
    in_v: na(inV, 0xffff, 100), out_v: na(outV, 0x7fff, 100), off_reason: off,
  };
}

// keys: { solar: hex, dcdc: hex }. Resolves to { kind, model, ...values }, or null when the
// broadcast isn't one we read or the key doesn't fit.
export async function readBroadcast(hex, keys) {
  const c = container(hexBytes(hex));
  if (!c) return null;
  const kind = c.type === RECORD.SOLAR ? 'solar' : c.type === RECORD.DCDC ? 'dcdc' : null;
  const keyBytes = kind && hexBytes((keys && keys[kind]) || '');
  if (!keyBytes || keyBytes.length !== 16 || keyBytes[0] !== c.keyCheck) return null;
  const plain = await decrypt(keyBytes, c.counter, c.data);
  return { kind, model: c.model, ...(kind === 'solar' ? parseSolar(plain) : parseDcdc(plain)) };
}

export const offReasonText = (bits) =>
  !bits ? '' : [...new Set(Object.entries(OFF_REASONS).filter(([b]) => bits & Number(b)).map(([, t]) => t))].join(', ');
