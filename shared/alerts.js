// Phone alerts: notifications from TrolaSpy itself (Web Push, see push.js), sent to every
// browser where the admin turned them on. (ntfy.sh was tried first, but its free quota is
// per internet address, and Cloudflare Workers share theirs with many other senders.)
// Rules are checked on every LeafSpy upload; state lives in the settings table.
import { KWH_PER_GID } from './charges.js';
import { sendPush } from './push.js';
import { dashSoc } from './soc.js';

export const DEFAULT_ALERTS = {
  enabled: false,
  target_on: true, target_soc: 80, // charged to this %
  done_on: true, // charging finished
  low_on: false, low_soc: 20, // battery below this % (not charging)
};

export async function getSettings(db, keys) {
  const { results } = await db.prepare(`SELECT key, value FROM settings WHERE key IN (${keys.map(() => '?').join(', ')})`)
    .bind(...keys).all();
  const out = {};
  for (const r of results) { try { out[r.key] = JSON.parse(r.value); } catch { out[r.key] = null; } }
  return out;
}

export function putSetting(db, key, value) {
  return db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').bind(key, JSON.stringify(value)).run();
}

const EMOJI = { zap: '⚡', white_check_mark: '✅', warning: '⚠️', wave: '👋' };

// Sends one alert to every subscribed browser; resolves to how many took it, or throws
// with the push service's reason when none did. `s` may carry the settings already read.
export async function sendAlert(db, { title, body, tags = [], priority = 3 }, s = null) {
  s = s || await getSettings(db, ['vapid', 'push_subs']);
  const subs = s.push_subs || [];
  if (!s.vapid || !subs.length) throw new Error('No phone has alerts turned on yet.');
  const icon = tags.map((t) => EMOJI[t]).filter(Boolean).join('');
  const payload = { title: icon ? `${icon} ${title}` : title, body, tag: tags[0] || 'trola' };
  const results = await Promise.all(subs.map((sub) => sendPush(sub, payload, s.vapid, { urgency: priority >= 4 ? 'high' : 'normal' })
    .catch((e) => ({ ok: false, status: 0, error: e.message }))));
  const gone = new Set(subs.filter((_, i) => [404, 410].includes(results[i].status)).map((x) => x.endpoint));
  if (gone.size) await putSetting(db, 'push_subs', subs.filter((x) => !gone.has(x.endpoint)));
  const sent = results.filter((r) => r.ok).length;
  if (!sent) {
    const err = results.find((r, i) => !gone.has(subs[i].endpoint));
    throw new Error(err ? err.error : 'This phone stopped accepting alerts. Turn them on again.');
  }
  return sent;
}

const isCharging = (r) => r.chrg_mode > 0 || (r.bat_amps < -3 && (r.speed || 0) < 1 && !r.pwr_sw);
const pct = (v) => `${Math.round(v)}%`;
const duration = (mins) => (mins >= 60 ? `${Math.floor(mins / 60)} h ${mins % 60} min` : `${mins} min`);

// LeafSpy goes quiet when the car sleeps, which it may do as soon as a charge ends. After this
// long without a charging reading, the charge counts as ended where LeafSpy last saw it.
export const CHARGE_QUIET_MS = 30 * 60 * 1000; // LeafSpy uploads every 7-11 min while charging

function doneAlert(st, end, quiet) {
  const kwh = end.gids && st.gids_start ? (end.gids - st.gids_start) * KWH_PER_GID : null;
  const mins = Math.round((end.ts - st.since) / 60000);
  return { title: 'Charging finished', tags: ['white_check_mark'],
    body: `${st.soc_start ? `${pct(st.soc_start)} → ` : ''}${end.soc ? pct(end.soc) : '?'}`
      + `${kwh && kwh > 0 ? `, +${kwh.toFixed(1)} kWh` : ''}${mins > 0 ? ` in about ${duration(mins)}` : ''}`
      + `${quiet ? ' (when LeafSpy last saw it)' : ''}.` };
}

// Called by the ingest Worker with each stored reading. Returns a promise for waitUntil.
// Battery % in alerts is the dashboard's (see soc.js), as the targets are.
export async function checkAlerts(db, reading) {
  const s = await getSettings(db, ['alerts', 'alert_state', 'vapid', 'push_subs', 'soc_cal']);
  const cfg = { ...DEFAULT_ALERTS, ...(s.alerts || {}) };
  if (!cfg.enabled || !s.vapid || !(s.push_subs || []).length) return;
  const row = { ...reading, soc: dashSoc(reading.soc, s.soc_cal) };
  const prev = s.alert_state || {};
  const st = { ...prev };
  const out = [];
  const charging = isCharging(row);
  const kw = row.bat_volts && row.bat_amps < 0 ? (-row.bat_volts * row.bat_amps) / 1000 : null;

  const quiet = !!(st.charging && st.last && row.ts - st.last.ts > CHARGE_QUIET_MS);
  if (st.charging && (!charging || quiet)) {
    st.charging = false;
    if (cfg.done_on) out.push(doneAlert(st, quiet ? st.last : row, quiet));
  }
  if (charging && !st.charging) {
    Object.assign(st, { charging: true, since: row.ts, soc_start: row.soc, gids_start: row.gids, target_sent: false });
  }
  if (charging) st.last = { ts: row.ts, soc: row.soc, gids: row.gids };
  if (charging && cfg.target_on && row.soc !== null && row.soc >= cfg.target_soc && !st.target_sent
      && !(st.soc_start >= cfg.target_soc)) { // not when plugged in above the target
    st.target_sent = true;
    out.push({ title: `Trola is at ${pct(row.soc)}`, tags: ['zap'], priority: 4,
      body: `Reached your ${cfg.target_soc}% target${kw ? `, charging at ${kw.toFixed(1)} kW` : ''}.` });
  }
  if (row.soc !== null) {
    if (!charging && cfg.low_on && row.soc <= cfg.low_soc && !st.low_sent) {
      st.low_sent = true;
      out.push({ title: `Trola battery low: ${pct(row.soc)}`, tags: ['warning'], priority: 4, body: `Below your ${cfg.low_soc}% alert.` });
    }
    if (st.low_sent && (charging || row.soc > cfg.low_soc + 5)) st.low_sent = false;
  }

  if (JSON.stringify(st) !== JSON.stringify(prev)) await putSetting(db, 'alert_state', st);
  for (const a of out) await sendAlert(db, a, s).catch((e) => console.log('alert not sent:', e.message));
}

// Run by the ingest Worker's 10-minute cron: ends a charge LeafSpy stopped reporting.
export async function checkQuietCharge(db, now = Date.now()) {
  const s = await getSettings(db, ['alerts', 'alert_state', 'vapid', 'push_subs']);
  const st = s.alert_state || {};
  if (!st.charging || !st.last || now - st.last.ts <= CHARGE_QUIET_MS) return;
  await putSetting(db, 'alert_state', { ...st, charging: false });
  const cfg = { ...DEFAULT_ALERTS, ...(s.alerts || {}) };
  if (!cfg.enabled || !cfg.done_on || !s.vapid || !(s.push_subs || []).length) return;
  await sendAlert(db, doneAlert(st, st.last, true), s).catch((e) => console.log('alert not sent:', e.message));
}
