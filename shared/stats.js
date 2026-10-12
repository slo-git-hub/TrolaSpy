// Driving and energy totals for a time range, and the per-day summaries built from them.
import { computeSessions } from './charges.js';

// Power is pack volts x amps: positive = drawing from the battery, negative = going in
// (regen while driving, or charging). Each reading's power is applied to the gap since
// the previous one; gaps over MAX_GAP_MS (LeafSpy off) count as nothing.
const MAX_GAP_MS = 150_000; // LeafSpy uploads every 35-120 s once the tablet dozes
const MS_PER_KWH = 3.6e9; // W x ms per kWh
const DAY_MS = 864e5;
const FOREVER = 8.64e15;

const STATS_SQL = `
WITH r AS (
  SELECT ts, odo, speed, pwr_sw, COALESCE(chrg_mode, 0) AS chrg_mode, bat_temp, amb_temp,
         NULLIF(soh, 0) AS soh, NULLIF(hx, 0) AS hx, NULLIF(ahr, 0) AS ahr,
         bat_volts * bat_amps AS w,
         ts - LAG(ts) OVER (ORDER BY ts) AS dt
    FROM readings WHERE ts >= ?3 AND ts < ?4)
SELECT
  COUNT(*) AS readings,
  SUM(CASE WHEN dt <= ?1 AND w > 0 AND chrg_mode = 0 THEN w * dt END) / ?2 AS used_kwh,
  SUM(CASE WHEN dt <= ?1 AND w < 0 AND chrg_mode = 0 AND pwr_sw = 1 THEN -w * dt END) / ?2 AS regen_kwh,
  SUM(CASE WHEN dt <= ?1 AND speed > 1 THEN dt END) / 1000.0 AS drive_s,
  MAX(speed) AS max_speed,
  MAX(NULLIF(odo, 0)) - MIN(NULLIF(odo, 0)) AS distance_km,
  MIN(bat_temp) AS bat_temp_min, MAX(bat_temp) AS bat_temp_max,
  MIN(amb_temp) AS amb_temp_min, MAX(amb_temp) AS amb_temp_max,
  MAX(CASE WHEN chrg_mode = 0 AND pwr_sw = 1 THEN -w END) / 1000.0 AS max_regen_kw, MAX(w) / 1000.0 AS max_power_kw,
  AVG(soh) AS soh, AVG(hx) AS hx, AVG(ahr) AS ahr
FROM r`;

export async function rangeStats(db, since, until = FOREVER) {
  const [row, sessions] = await Promise.all([
    db.prepare(STATS_SQL).bind(MAX_GAP_MS, MS_PER_KWH, since, until).first(),
    computeSessions(db, since, until),
  ]);
  // Charged energy comes from the charging sessions (they also count charges LeafSpy missed).
  return { ...row, charged_kwh: sessions.reduce((t, s) => t + (s.kwh || 0), 0), charges: sessions.length };
}

// ---------- Daily summaries (UTC days) ----------
// One row per finished day, stored so month views and battery health over years stay cheap.

export const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10);
const dayStart = (ms) => Math.floor(ms / DAY_MS) * DAY_MS;
const DAILY_COLS = ['day', 'readings', 'distance_km', 'drive_s', 'used_kwh', 'regen_kwh', 'charged_kwh', 'charges',
  'max_speed', 'soh', 'hx', 'ahr', 'amb_min', 'amb_max'];

async function computeDay(db, start) {
  const s = await rangeStats(db, start, start + DAY_MS);
  return {
    day: dayKey(start), readings: s.readings, distance_km: s.distance_km, drive_s: s.drive_s,
    used_kwh: s.used_kwh, regen_kwh: s.regen_kwh, charged_kwh: s.charged_kwh, charges: s.charges,
    max_speed: s.max_speed, soh: s.soh, hx: s.hx, ahr: s.ahr, amb_min: s.amb_temp_min, amb_max: s.amb_temp_max,
  };
}

// Works out and stores any finished day in [from, to) that has no summary yet
// (at most `limit` per call, oldest first: each day costs 3 queries, and a Worker on the
// free plan may make 50). Days before the first reading are skipped.
export async function ensureDays(db, from = 0, to = FOREVER, limit = 10) {
  const first = await db.prepare('SELECT MIN(ts) AS ts FROM readings').first();
  if (!first || first.ts === null) return 0;
  const start = dayStart(Math.max(from, first.ts));
  const end = Math.min(dayStart(to), dayStart(Date.now()));
  if (start >= end) return 0;
  const { results } = await db.prepare('SELECT day FROM daily WHERE day >= ? AND day < ?')
    .bind(dayKey(start), dayKey(end)).all();
  const have = new Set(results.map((r) => r.day));
  const missing = [];
  for (let t = start; t < end && missing.length < limit; t += DAY_MS) if (!have.has(dayKey(t))) missing.push(t);
  if (!missing.length) return 0;
  const rows = await Promise.all(missing.map((t) => computeDay(db, t)));
  const stmt = db.prepare(`INSERT OR REPLACE INTO daily (${DAILY_COLS.join(', ')}, computed_ts)
                           VALUES (${DAILY_COLS.map(() => '?').join(', ')}, ?)`);
  await db.batch(rows.map((r) => stmt.bind(...DAILY_COLS.map((c) => r[c] ?? null), Date.now())));
  return rows.length;
}

// Day summaries for [fromKey, toKey] (inclusive, YYYY-MM-DD); today is worked out live.
export async function listDays(db, fromKey, toKey) {
  const { results } = await db.prepare('SELECT * FROM daily WHERE day >= ? AND day <= ? ORDER BY day')
    .bind(fromKey, toKey).all();
  const today = dayKey(Date.now());
  if (today >= fromKey && today <= toKey) results.push(await computeDay(db, dayStart(Date.now())));
  return results.filter((r) => r.readings > 0);
}

// Summaries are recomputed after readings change (restore or delete).
export async function forgetDays(db, from, to) {
  await db.prepare('DELETE FROM daily WHERE day >= ? AND day <= ?').bind(dayKey(from), dayKey(to)).run();
}
