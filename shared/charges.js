// Charging sessions, worked out from readings (used by both Workers).
// A reading counts as charging when the car says so (ChrgMode) or when current flows into a
// parked, switched-off pack (add-on chargers). Charging readings less than SESSION_GAP_MS
// apart belong to one session. Energy is pack volts x amps over time, so it is what went
// into the battery, from the car's charger or any add-on charger.

const SESSION_GAP_MS = 15 * 60 * 1000;
const MAX_STEP_MS = 5 * 60 * 1000; // longer gaps between readings add no energy
const MS_PER_KWH = 3.6e9;

const SESSIONS_SQL = `
WITH r AS (
  SELECT ts, lat, lon, soc, chrg_mode, bat_volts * bat_amps AS w
    FROM readings
   WHERE ts >= ?1
     AND (chrg_mode > 0 OR (bat_amps < -3 AND COALESCE(speed, 0) < 1 AND COALESCE(pwr_sw, 0) = 0))),
d AS (SELECT *, ts - LAG(ts) OVER (ORDER BY ts) AS dt FROM r),
g AS (SELECT *, SUM(CASE WHEN dt IS NULL OR dt > ?2 THEN 1 ELSE 0 END) OVER (ORDER BY ts) AS sid FROM d),
s AS (
  SELECT MIN(ts) AS start_ts, MAX(ts) AS end_ts,
         AVG(lat) AS alat, AVG(lon) AS alon,
         SUM(CASE WHEN dt <= ?3 AND w < 0 THEN -w * dt END) / ?4 AS kwh,
         SUM(CASE WHEN dt <= ?3 AND w < 0 THEN dt END) AS charge_ms,
         MAX(-w) / 1000.0 AS max_kw,
         MIN(soc) AS soc_start, MAX(soc) AS soc_end,
         MAX(chrg_mode) AS mode
    FROM g GROUP BY sid)
SELECT start_ts, end_ts, kwh, charge_ms, max_kw, soc_start, soc_end, mode,
       COALESCE(alat, (SELECT lat FROM readings WHERE ts <= s.end_ts AND lat IS NOT NULL ORDER BY ts DESC LIMIT 1)) AS lat,
       COALESCE(alon, (SELECT lon FROM readings WHERE ts <= s.end_ts AND lat IS NOT NULL ORDER BY ts DESC LIMIT 1)) AS lon
  FROM s
 WHERE kwh >= 0.1 OR end_ts - start_ts >= 120000
 ORDER BY start_ts`;

export async function computeSessions(db, since = 0) {
  const { results } = await db.prepare(SESSIONS_SQL).bind(since, SESSION_GAP_MS, MAX_STEP_MS, MS_PER_KWH).all();
  return results;
}

// Copies finished sessions into the charges table, so they outlive the readings
// (which are deleted after 30 days). A session that overlaps one already stored is
// skipped, so one cut short by that deletion is never stored a second time.
export async function archiveSessions(db, now = Date.now()) {
  const { results: stored } = await db.prepare('SELECT start_ts, end_ts FROM charges').all();
  const done = (await computeSessions(db)).filter((s) => s.end_ts < now - SESSION_GAP_MS && s.lat !== null
    && !stored.some((a) => s.start_ts <= a.end_ts && a.start_ts <= s.end_ts));
  if (!done.length) return 0;
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO charges (start_ts, end_ts, lat, lon, kwh, charge_ms, max_kw, soc_start, soc_end, mode)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  await db.batch(done.map((s) => stmt.bind(s.start_ts, s.end_ts, s.lat, s.lon, s.kwh, s.charge_ms, s.max_kw, s.soc_start, s.soc_end, s.mode)));
  return done.length;
}

// Every session: stored ones plus anything newer still only in readings.
export async function listSessions(db) {
  const { results: stored } = await db.prepare('SELECT * FROM charges ORDER BY start_ts').all();
  // Only readings after the last stored session need working out.
  const live = await computeSessions(db, stored.length ? stored[stored.length - 1].end_ts + 1 : 0);
  const overlaps = (s) => stored.some((a) => a.start_ts <= s.start_ts && s.start_ts <= a.end_ts);
  return [...stored, ...live.filter((s) => s.lat !== null && !overlaps(s))].sort((a, b) => b.start_ts - a.start_ts);
}
