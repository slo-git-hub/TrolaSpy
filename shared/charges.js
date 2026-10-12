// Charging sessions, worked out from readings (used by both Workers).
// A reading counts as charging when the car says so (ChrgMode) or when current flows into a
// parked, switched-off pack (add-on chargers). Charging readings less than SESSION_GAP_MS
// apart belong to one session.
// Energy: while the tablet sleeps LeafSpy uploads only every few minutes, so adding up
// volts x amps misses most of a charge. The pack's Gids (energy units, 77.5 Wh each) count
// everything that went in; the larger of the two is used. Both are energy into the battery
// (from the car's charger or an add-on charger), a bit less than taken from the grid.

const SESSION_GAP_MS = 20 * 60 * 1000;
const MS_PER_KWH = 3.6e9;
export const KWH_PER_GID = 0.0775;

const SESSIONS_SQL = `
WITH r AS (
  SELECT ts, lat, lon, NULLIF(soc, 0) AS soc, NULLIF(gids, 0) AS gids, chrg_mode, bat_volts * bat_amps AS w
    FROM readings
   WHERE ts >= ?1 AND ts < ?5
     AND (chrg_mode > 0 OR (bat_amps < -3 AND COALESCE(speed, 0) < 1 AND COALESCE(pwr_sw, 0) = 0))),
d AS (SELECT *, ts - LAG(ts) OVER (ORDER BY ts) AS dt FROM r),
g AS (SELECT *, SUM(CASE WHEN dt IS NULL OR dt > ?2 THEN 1 ELSE 0 END) OVER (ORDER BY ts) AS sid FROM d),
s AS (
  SELECT MIN(ts) AS start_ts, MAX(ts) AS end_ts,
         AVG(lat) AS alat, AVG(lon) AS alon,
         SUM(CASE WHEN dt <= ?2 AND w < 0 THEN -w * dt END) / ?3 AS va_kwh,
         MAX(-w) / 1000.0 AS max_kw,
         MIN(soc) AS soc_start, MAX(soc) AS soc_max,
         MIN(gids) AS gids_start, MAX(gids) AS gids_max,
         MAX(chrg_mode) AS mode
    FROM g GROUP BY sid),
e AS (
  -- The first reading after the session (once unplugged) shows where the battery ended up.
  SELECT s.*,
         (SELECT NULLIF(gids, 0) FROM readings WHERE ts > s.end_ts AND ts < s.end_ts + ?2 AND gids > 0 ORDER BY ts LIMIT 1) AS gids_after,
         (SELECT NULLIF(soc, 0) FROM readings WHERE ts > s.end_ts AND ts < s.end_ts + ?2 AND soc > 0 ORDER BY ts LIMIT 1) AS soc_after
    FROM s),
k AS (
  SELECT e.*, MAX(COALESCE(va_kwh, 0),
                  COALESCE((MAX(COALESCE(gids_max, 0), COALESCE(gids_after, 0)) - gids_start) * ?4, 0)) AS kwh
    FROM e)
SELECT start_ts, end_ts, kwh, end_ts - start_ts AS charge_ms, max_kw, soc_start,
       MAX(COALESCE(soc_max, 0), COALESCE(soc_after, 0)) AS soc_end, mode,
       COALESCE(alat, (SELECT lat FROM readings WHERE ts <= k.end_ts AND lat IS NOT NULL ORDER BY ts DESC LIMIT 1)) AS lat,
       COALESCE(alon, (SELECT lon FROM readings WHERE ts <= k.end_ts AND lat IS NOT NULL ORDER BY ts DESC LIMIT 1)) AS lon
  FROM k
 WHERE kwh >= 0.1 OR end_ts - start_ts >= 120000
 ORDER BY start_ts`;

// Charges LeafSpy never saw (car off, no uploads): the battery holds clearly more energy
// after a gap in readings than before it, and the van did not move in between.
const SILENT_GAP_MS = 10 * 60 * 1000;
const SILENT_MIN_GIDS = 13; // about 1 kWh
const SILENT_SQL = `
WITH a AS (
  SELECT ts, lat, lon, odo, NULLIF(gids, 0) AS gids, NULLIF(soc, 0) AS soc,
         LAG(ts) OVER w AS pts, LAG(NULLIF(gids, 0)) OVER w AS pgids, LAG(NULLIF(soc, 0)) OVER w AS psoc,
         LAG(lat) OVER w AS plat, LAG(lon) OVER w AS plon, LAG(odo) OVER w AS podo
    FROM readings WHERE ts >= ?1 AND ts < ?5 WINDOW w AS (ORDER BY ts))
SELECT pts AS start_ts, ts AS end_ts, (gids - pgids) * ?4 AS kwh, NULL AS charge_ms, NULL AS max_kw,
       psoc AS soc_start, soc AS soc_end, NULL AS mode,
       COALESCE(plat, lat, (SELECT lat FROM readings WHERE ts <= a.pts AND lat IS NOT NULL ORDER BY ts DESC LIMIT 1)) AS lat,
       COALESCE(plon, lon, (SELECT lon FROM readings WHERE ts <= a.pts AND lat IS NOT NULL ORDER BY ts DESC LIMIT 1)) AS lon
  FROM a
 WHERE ts - pts > ?2 AND gids - pgids >= ?3 AND COALESCE(odo - podo, 0) <= 1
 ORDER BY pts`;

export async function computeSessions(db, since = 0, until = 8.64e15) {
  const [{ results: seen }, { results: silent }] = await Promise.all([
    db.prepare(SESSIONS_SQL).bind(since, SESSION_GAP_MS, MS_PER_KWH, KWH_PER_GID, until).all(),
    db.prepare(SILENT_SQL).bind(since, SILENT_GAP_MS, SILENT_MIN_GIDS, KWH_PER_GID, until).all(),
  ]);
  // A gap inside a session LeafSpy saw is already counted there.
  const extra = silent.filter((g) => !seen.some((s) => g.start_ts < s.end_ts && g.end_ts > s.start_ts));
  // Join pieces of one charge: seen part, silent gap, seen part.
  const merged = [];
  for (const s of [...seen, ...extra].sort((a, b) => a.start_ts - b.start_ts)) {
    const last = merged[merged.length - 1];
    if (last && s.start_ts - last.end_ts <= SESSION_GAP_MS && (last.silent || s.mode === null)) {
      last.end_ts = Math.max(last.end_ts, s.end_ts);
      last.kwh += s.kwh || 0;
      last.charge_ms = last.end_ts - last.start_ts;
      last.max_kw = last.max_kw === null ? s.max_kw : s.max_kw === null ? last.max_kw : Math.max(last.max_kw, s.max_kw);
      last.soc_end = s.soc_end ?? last.soc_end;
      last.mode = last.mode === null ? s.mode : s.mode === null ? last.mode : Math.max(last.mode, s.mode);
      last.silent = s.mode === null;
    } else {
      merged.push({ ...s, silent: s.mode === null });
    }
  }
  return merged.map(({ silent, ...s }) => s);
}

// Copies finished sessions into the charges table, so they outlive the readings
// (if RETENTION_DAYS deletes old ones, or the admin deletes a range). A session that
// overlaps one already stored is skipped, so one cut short is never stored a second time.
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
