// Phone alerts through ntfy (https://ntfy.sh): the admin installs the free ntfy app and
// subscribes to a private, randomly named topic that the admin page shows.
// Rules are checked on every LeafSpy upload; state lives in the settings table.
import { KWH_PER_GID } from './charges.js';

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

export async function sendAlert(topic, { title, body, tags = [], priority = 3 }) {
  const res = await fetch(`https://ntfy.sh/${encodeURIComponent(topic)}`, {
    method: 'POST',
    headers: { Title: title, Tags: tags.join(','), Priority: String(priority) },
    body,
  });
  return res.ok;
}

const isCharging = (r) => r.chrg_mode > 0 || (r.bat_amps < -3 && (r.speed || 0) < 1 && !r.pwr_sw);
const pct = (v) => `${Math.round(v)}%`;

// Called by the ingest Worker with each stored reading. Returns a promise for waitUntil.
export async function checkAlerts(db, row) {
  const s = await getSettings(db, ['alerts', 'ntfy_topic', 'alert_state']);
  const cfg = { ...DEFAULT_ALERTS, ...(s.alerts || {}) };
  if (!cfg.enabled || !s.ntfy_topic) return;
  const prev = s.alert_state || {};
  const st = { ...prev };
  const out = [];
  const charging = isCharging(row);
  const kw = row.bat_volts && row.bat_amps < 0 ? (-row.bat_volts * row.bat_amps) / 1000 : null;

  if (charging && !st.charging) {
    Object.assign(st, { charging: true, since: row.ts, soc_start: row.soc, gids_start: row.gids, target_sent: false });
  }
  if (charging && cfg.target_on && row.soc !== null && row.soc >= cfg.target_soc && !st.target_sent
      && !(st.soc_start >= cfg.target_soc)) { // not when plugged in above the target
    st.target_sent = true;
    out.push({ title: `Trola is at ${pct(row.soc)}`, tags: ['zap'], priority: 4,
      body: `Reached your ${cfg.target_soc}% target${kw ? `, charging at ${kw.toFixed(1)} kW` : ''}.` });
  }
  if (!charging && st.charging) {
    st.charging = false;
    if (cfg.done_on) {
      const kwh = row.gids && st.gids_start ? (row.gids - st.gids_start) * KWH_PER_GID : null;
      const mins = Math.round((row.ts - st.since) / 60000);
      out.push({ title: 'Charging finished', tags: ['white_check_mark'],
        body: `${st.soc_start ? `${pct(st.soc_start)} → ` : ''}${row.soc ? pct(row.soc) : '?'}`
          + `${kwh && kwh > 0 ? `, +${kwh.toFixed(1)} kWh` : ''}${mins > 0 ? ` in about ${mins >= 60 ? `${Math.floor(mins / 60)} h ${mins % 60} min` : `${mins} min`}` : ''}.` });
    }
  }
  if (row.soc !== null) {
    if (!charging && cfg.low_on && row.soc <= cfg.low_soc && !st.low_sent) {
      st.low_sent = true;
      out.push({ title: `Trola battery low: ${pct(row.soc)}`, tags: ['warning'], priority: 4, body: `Below your ${cfg.low_soc}% alert.` });
    }
    if (st.low_sent && (charging || row.soc > cfg.low_soc + 5)) st.low_sent = false;
  }

  if (JSON.stringify(st) !== JSON.stringify(prev)) await putSetting(db, 'alert_state', st);
  await Promise.all(out.map((a) => sendAlert(s.ntfy_topic, a).catch(() => false)));
}
