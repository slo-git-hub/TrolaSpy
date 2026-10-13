// Charging sessions, worked out from readings (used by both Workers).
// A reading counts as charging when the car says so (ChrgMode) or when current flows into a
// parked, switched-off pack (add-on chargers). Charging readings less than SESSION_GAP_MS
// apart belong to one session.
// Energy: while the tablet sleeps LeafSpy uploads only every few minutes, so adding up
// volts x amps misses most of a charge. The pack's Gids (energy units, 77.5 Wh each) count
// everything that went in; the larger of the two is used. Both are energy into the battery
// (from the car's charger or an add-on charger), a bit less than taken from the grid.
// The work is done here rather than in SQL: D1's free plan allows 5 million rows read a day,
// and window functions (LAG, running sums) read every row several times over.

export const SESSION_GAP_MS = 20 * 60 * 1000;
const MS_PER_KWH = 3.6e9;
export const KWH_PER_GID = 0.0775;

// Readings in [since, until) with what sessions and day totals need, oldest first.
const SCAN_COLS = 'ts, lat, lon, odo, speed, pwr_sw, chrg_mode, soc, gids, bat_volts, bat_amps, bat_temp, amb_temp, soh, hx, ahr';
export async function scanReadings(db, since, until) {
  const { results } = await db.prepare(`SELECT ${SCAN_COLS} FROM readings WHERE ts >= ? AND ts < ? ORDER BY ts`)
    .bind(since, until).all();
  return results;
}

const watts = (r) => (r.bat_volts === null || r.bat_amps === null ? null : r.bat_volts * r.bat_amps);
const pos = (v) => (v ? v : null); // LeafSpy's 0 means "no value" for SOC and Gids
const isCharging = (r) => r.chrg_mode > 0 || (r.bat_amps !== null && r.bat_amps < -3 && (r.speed ?? 0) < 1 && (r.pwr_sw ?? 0) === 0);
const maxOf = (a, b) => (a === null ? b : b === null ? a : Math.max(a, b));
const minOf = (a, b) => (a === null ? b : b === null ? a : Math.min(a, b));

// Last known position at or before ts: from the scanned rows, else from the database.
async function placeAt(db, rows, i, ts) {
  for (let j = i; j >= 0; j--) if (rows[j].lat !== null) return { lat: rows[j].lat, lon: rows[j].lon };
  return (await db.prepare('SELECT lat, lon FROM readings WHERE ts <= ? AND lat IS NOT NULL ORDER BY ts DESC LIMIT 1').bind(ts).first())
    || { lat: null, lon: null };
}

// Sessions LeafSpy saw. `rows` may run past `until` (for the first reading after a session).
async function seenSessions(db, rows, until) {
  const out = [];
  let s = null, prevTs = null;
  const close = async () => {
    if (!s) return;
    // The first reading after the session (once unplugged) shows where the battery ended up.
    let gidsAfter = null, socAfter = null;
    for (let j = s.lastIdx + 1; j < rows.length && rows[j].ts < s.end_ts + SESSION_GAP_MS; j++) {
      if (gidsAfter === null && pos(rows[j].gids)) gidsAfter = rows[j].gids;
      if (socAfter === null && pos(rows[j].soc)) socAfter = rows[j].soc;
    }
    const gidsKwh = s.gids_start === null ? 0 : (Math.max(s.gids_max ?? 0, gidsAfter ?? 0) - s.gids_start) * KWH_PER_GID;
    const kwh = Math.max(s.va_kwh ?? 0, gidsKwh);
    const charge_ms = s.end_ts - s.start_ts;
    if (kwh >= 0.1 || charge_ms >= 120000) {
      const place = s.nlat ? { lat: s.lat / s.nlat, lon: s.lon / s.nlat } : await placeAt(db, rows, s.lastIdx, s.end_ts);
      out.push({ start_ts: s.start_ts, end_ts: s.end_ts, kwh, charge_ms, max_kw: s.max_w === null ? null : s.max_w / 1000,
        soc_start: s.soc_start, soc_end: Math.max(s.soc_max ?? 0, socAfter ?? 0), mode: s.mode, ...place });
    }
    s = null;
  };
  for (let i = 0; i < rows.length && rows[i].ts < until; i++) {
    const r = rows[i];
    if (!isCharging(r)) continue;
    const dt = prevTs === null ? null : r.ts - prevTs;
    prevTs = r.ts;
    if (dt === null || dt > SESSION_GAP_MS) {
      await close();
      s = { start_ts: r.ts, va_kwh: null, max_w: null, soc_start: null, soc_max: null, gids_start: null, gids_max: null,
        mode: null, lat: 0, lon: 0, nlat: 0 };
    }
    const w = watts(r), soc = pos(r.soc), gids = pos(r.gids);
    s.end_ts = r.ts; s.lastIdx = i;
    if (dt !== null && dt <= SESSION_GAP_MS && w !== null && w < 0) s.va_kwh = (s.va_kwh ?? 0) + (-w * dt) / MS_PER_KWH;
    if (w !== null) s.max_w = maxOf(s.max_w, -w);
    s.soc_start = minOf(s.soc_start, soc); s.soc_max = maxOf(s.soc_max, soc);
    s.gids_start = minOf(s.gids_start, gids); s.gids_max = maxOf(s.gids_max, gids);
    if (r.chrg_mode !== null) s.mode = maxOf(s.mode, r.chrg_mode);
    if (r.lat !== null) { s.lat += r.lat; s.lon += r.lon; s.nlat++; }
  }
  await close();
  return out;
}

// Charges LeafSpy never saw (car off, no uploads): the battery holds clearly more energy
// after a gap in readings than before it, and the van did not move in between.
const SILENT_GAP_MS = 10 * 60 * 1000;
const SILENT_MIN_GIDS = 13; // about 1 kWh
async function silentCharges(db, rows, until) {
  const out = [];
  for (let i = 1; i < rows.length && rows[i].ts < until; i++) {
    const a = rows[i - 1], b = rows[i];
    const g0 = pos(a.gids), g1 = pos(b.gids);
    if (b.ts - a.ts <= SILENT_GAP_MS || g0 === null || g1 === null || g1 - g0 < SILENT_MIN_GIDS) continue;
    if (a.odo !== null && b.odo !== null && b.odo - a.odo > 1) continue;
    const place = a.lat !== null ? { lat: a.lat, lon: a.lon } : b.lat !== null ? { lat: b.lat, lon: b.lon } : await placeAt(db, rows, i - 1, a.ts);
    out.push({ start_ts: a.ts, end_ts: b.ts, kwh: (g1 - g0) * KWH_PER_GID, charge_ms: null, max_kw: null,
      soc_start: pos(a.soc), soc_end: pos(b.soc), mode: null, ...place });
  }
  return out;
}

// Sessions from readings already scanned (`rows` covers [since, until + SESSION_GAP_MS)).
export async function sessionsFrom(db, rows, until) {
  const [seen, silent] = [await seenSessions(db, rows, until), await silentCharges(db, rows, until)];
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

export async function computeSessions(db, since = 0, until = Date.now() + 1) {
  return sessionsFrom(db, await scanReadings(db, since, until + SESSION_GAP_MS), until);
}

// Sessions are worked out from readings only after `charges_through` (settings): the
// archive below moves it forward, so the live part stays about a day long. A restore of
// older readings moves it back (see admin.js), and the archive catches up.
export async function through(db) {
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'charges_through'").first();
  const v = row ? Number(JSON.parse(row.value)) : NaN;
  if (Number.isFinite(v)) return v;
  const last = await db.prepare('SELECT MAX(end_ts) AS t FROM charges').first();
  return last && last.t !== null ? last.t + 1 : 0;
}

// Copies finished sessions into the charges table, so they outlive the readings
// (if RETENTION_DAYS deletes old ones, or the admin deletes a range). A session that
// overlaps one already stored is skipped, so one cut short is never stored a second time.
// Works through at most ARCHIVE_SPAN_MS of readings per call; `more` says there is more.
const ARCHIVE_SPAN_MS = 2 * 864e5;
export async function archiveSessions(db, until = Date.now()) {
  const from = await through(db);
  let now = until, more = false;
  if (until - from > ARCHIVE_SPAN_MS) {
    // The stretch ends just after the first reading past the span (LeafSpy may have been off for days).
    const nx = await db.prepare('SELECT ts FROM readings WHERE ts >= ? ORDER BY ts LIMIT 1').bind(from + ARCHIVE_SPAN_MS).first();
    if (nx && nx.ts + SESSION_GAP_MS + 1 < until) { now = nx.ts + SESSION_GAP_MS + 1; more = true; }
  }
  const [{ results: stored }, sessions] = await Promise.all([
    db.prepare('SELECT start_ts, end_ts FROM charges WHERE end_ts >= ?').bind(from - SESSION_GAP_MS).all(),
    computeSessions(db, from, now),
  ]);
  const finished = (s) => s.end_ts < now - SESSION_GAP_MS;
  const done = sessions.filter((s) => finished(s) && s.lat !== null
    && !stored.some((a) => s.start_ts <= a.end_ts && a.start_ts <= s.end_ts));
  // Next time, start at the last reading before anything still going, so a charge the car
  // makes while LeafSpy is off (a gap after that reading) is still found.
  const lastBefore = async (t) => {
    const r = await db.prepare('SELECT ts FROM readings WHERE ts <= ? ORDER BY ts DESC LIMIT 1').bind(t).first();
    return Math.max(from, r ? r.ts : 0);
  };
  const open = sessions.filter((s) => !finished(s)).map((s) => s.start_ts);
  let next = await lastBefore(Math.min(now - SESSION_GAP_MS, ...open));
  if (more && next <= from) next = await lastBefore(now - SESSION_GAP_MS); // a charge longer than the stretch
  const stmts = done.map((s) => db.prepare(
    `INSERT OR REPLACE INTO charges (start_ts, end_ts, lat, lon, kwh, charge_ms, max_kw, soc_start, soc_end, mode)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(s.start_ts, s.end_ts, s.lat, s.lon, s.kwh, s.charge_ms, s.max_kw, s.soc_start, s.soc_end, s.mode));
  stmts.push(db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('charges_through', ?)").bind(JSON.stringify(next)));
  await db.batch(stmts);
  return { archived: done.length, more };
}

// A restore added readings from `ts` on: work their sessions out again from there.
export async function rewindSessions(db, ts) {
  if (!(ts < (await through(db)))) return;
  await db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('charges_through', ?)").bind(JSON.stringify(ts)).run();
}

// Every session: stored ones plus anything newer still only in readings.
export async function listSessions(db) {
  const [{ results: stored }, from] = await Promise.all([db.prepare('SELECT * FROM charges ORDER BY start_ts').all(), through(db)]);
  const live = await computeSessions(db, from);
  const overlaps = (s) => stored.some((a) => a.start_ts <= s.start_ts && s.start_ts <= a.end_ts);
  return [...stored, ...live.filter((s) => s.lat !== null && !overlaps(s))].sort((a, b) => b.start_ts - a.start_ts);
}
