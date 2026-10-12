// Uploads from the TrolaSpy Bridge app on the tablet: the newest Bluetooth broadcast it heard
// from each Victron device. They are decrypted with the keys the admin saved (settings
// 'victron') and stored in the victron table; what the app hears is kept in settings 'bridge'
// so the admin page can show it.
import { container, readBroadcast, RECORD } from '../../shared/victron.js';
import { getSettings, putSetting } from '../../shared/alerts.js';

const KEEP_MS = 15 * 60 * 1000; // an unchanged reading is stored at most this often
const MAX_AGE_MS = 10 * 60 * 1000; // older broadcasts are only listed, not stored
const VALUES = ['state', 'error', 'batt_v', 'batt_a', 'pv_w', 'yield_wh', 'in_v', 'out_v', 'off_reason'];
const KINDS = { [RECORD.SOLAR]: 'solar', [RECORD.DCDC]: 'dcdc' };

const hexOf = (v) => (typeof v === 'string' && /^[0-9a-f]{18,64}$/i.test(v) ? v.toLowerCase() : null);

export async function handleBridge(db, body, now = Date.now()) {
  const list = Array.isArray(body && body.devices) ? body.devices.slice(0, 10) : [];
  const { victron: keys } = await getSettings(db, ['victron']);
  const seen = [], stored = [];
  for (const d of list) {
    const hex = hexOf(d && d.data);
    const c = hex && container(Uint8Array.from(hex.match(/../g), (b) => parseInt(b, 16)));
    const age = Math.min(Math.max(Number(d && d.age_ms) || 0, 0), 24 * 3600e3);
    const r = c ? await readBroadcast(hex, keys || {}).catch(() => null) : null;
    seen.push({
      mac: String((d && d.mac) || '').slice(0, 17), name: String((d && d.name) || '').slice(0, 40),
      rssi: Number(d && d.rssi) || null, kind: c ? KINDS[c.type] || `type ${c.type}` : 'unknown',
      model: c ? c.model : null, read: !!r, heard_ts: now - age,
    });
    if (!r || age > MAX_AGE_MS) continue;
    const ts = Math.round(now - age);
    const row = VALUES.map((k) => r[k] ?? null);
    const last = await db.prepare(`SELECT ts, ${VALUES.join(', ')} FROM victron WHERE kind = ? ORDER BY ts DESC LIMIT 1`)
      .bind(r.kind).first();
    if (last && (ts <= last.ts || (ts - last.ts < KEEP_MS && VALUES.every((k, i) => last[k] === row[i])))) continue;
    await db.prepare(`INSERT OR REPLACE INTO victron (kind, ts, ${VALUES.join(', ')}) VALUES (?, ?, ${VALUES.map(() => '?').join(', ')})`)
      .bind(r.kind, ts, ...row).run();
    stored.push(r.kind);
  }
  await putSetting(db, 'bridge', { ts: now, app: String((body && body.app) || '').slice(0, 40), devices: seen });
  return { heard: seen.length, read: seen.filter((s) => s.read).length, stored };
}
