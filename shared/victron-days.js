// Victron totals per UTC day: the solar yield (the charger's own "today" total, taken while the
// sun is on the panels, since it only resets when they wake up the next morning) and how long
// the DC-DC charger ran. A row is stored on every change and at least every 15 minutes, so each
// "on" row counts until the next one, but for at most RUN_GAP_MS (the bridge app may have stopped).
// Finished days are kept in victron_days, so their rows are read only once.
import { dayKey } from './stats.js';

export const RUN_GAP_MS = 20 * 60 * 1000;
const DAY_MS = 864e5;

const victronDay = (db, from, to, now) => [
  db.prepare(`SELECT MAX(yield_wh) AS wh FROM victron WHERE kind = 'solar' AND pv_w > 0 AND ts >= ? AND ts < ?`).bind(from, to),
  db.prepare(`WITH r AS (SELECT ts, state, LEAD(ts) OVER (ORDER BY ts) AS nx FROM victron WHERE kind = 'dcdc' AND ts >= ?1 AND ts < ?2 + ?3)
              SELECT SUM(MIN(COALESCE(nx, ?4), ts + ?3) - ts) AS on_ms FROM r WHERE state > 0 AND ts < ?2`).bind(from, to, RUN_GAP_MS, now),
];

// Days from `first` to `last` (UTC day starts, both included), oldest first. A finished day not
// stored yet is worked out and stored, at most `limit` per call (a free-plan Worker may make 50
// subrequests); `more` says some were left for the next call. Days before the chargers were
// first heard are left out.
export async function victronDays(db, now, first, last, limit = 10) {
  const [{ results: stored }, start] = await Promise.all([
    db.prepare('SELECT * FROM victron_days WHERE day >= ? AND day <= ?').bind(dayKey(first), dayKey(last)).all(),
    db.prepare(`SELECT MIN(a) AS ts FROM (SELECT MIN(ts) AS a FROM victron WHERE kind = 'solar'
                UNION ALL SELECT MIN(ts) FROM victron WHERE kind = 'dcdc')`).first(),
  ]);
  if (!start || start.ts === null) return { days: stored, more: false };
  const have = new Set(stored.map((d) => d.day));
  const store = [], live = [];
  let more = false;
  for (let t = Math.max(first, Math.floor(start.ts / DAY_MS) * DAY_MS); t <= last; t += DAY_MS) {
    if (have.has(dayKey(t))) continue;
    if (t + DAY_MS + RUN_GAP_MS > now) live.push(t); else if (store.length < limit) store.push(t); else more = true;
  }
  const want = [...store, ...live];
  const res = want.length ? await db.batch(want.flatMap((t) => victronDay(db, t, t + DAY_MS, now))) : [];
  const got = want.map((t, i) => ({ day: dayKey(t), solar_wh: res[2 * i].results[0].wh, dcdc_on_ms: res[2 * i + 1].results[0].on_ms }));
  if (store.length) {
    const ins = db.prepare('INSERT OR REPLACE INTO victron_days (day, solar_wh, dcdc_on_ms) VALUES (?, ?, ?)');
    await db.batch(got.slice(0, store.length).map((d) => ins.bind(d.day, d.solar_wh, d.dcdc_on_ms)));
  }
  return { days: [...stored, ...got].sort((a, b) => (a.day < b.day ? -1 : 1)), more };
}
