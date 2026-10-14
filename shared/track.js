// Trola's track between two times (ms), downsampled to two points per bucket (its first and last
// reading). Up to 2 days, grouping reads every reading once; longer ranges look up each bucket's
// first and last reading by time instead, which reads about two rows per bucket rather than every
// reading (D1's free plan counts rows read). The last reading before the car was switched off and
// the first after it keep where it was parked, which night and stop pins need.
// cols: the columns to return, from the readings table as `r`.
export async function track(db, since, until, cols, maxPoints) {
  if (until <= since) return { since, until, bucketMs: 0, points: [] };
  const bucketMs = Math.max(10_000, Math.ceil((until - since) / (maxPoints / 2)));
  const sql = until - since <= 48 * 3600e3
    ? `WITH g AS (SELECT MIN(ts) AS a, MAX(ts) AS z FROM readings WHERE ts >= ?1 AND ts <= ?3 GROUP BY ts / CAST(?2 AS INTEGER)),
            k(ts) AS (SELECT a FROM g UNION SELECT z FROM g)
       SELECT ${cols} FROM k JOIN readings r ON r.ts = k.ts ORDER BY r.ts`
    : `WITH RECURSIVE b(t) AS (SELECT ?1 UNION ALL SELECT t + ?2 FROM b WHERE t + ?2 < ?3),
            k(ts) AS (SELECT (SELECT ts FROM readings WHERE ts >= b.t AND ts < b.t + ?2 AND ts <= ?3 ORDER BY ts LIMIT 1) FROM b
                      UNION SELECT (SELECT ts FROM readings WHERE ts >= b.t AND ts < b.t + ?2 AND ts <= ?3 ORDER BY ts DESC LIMIT 1) FROM b)
       SELECT ${cols} FROM k JOIN readings r ON r.ts = k.ts ORDER BY r.ts`;
  // The readings just outside the range, so a stay that began before it or ended after it is seen whole.
  const edge = (op, dir, ts) => db.prepare(`SELECT ts, lat, lon FROM readings WHERE ts ${op} ? ORDER BY ts ${dir} LIMIT 1`).bind(ts).first();
  const [{ results }, before, after] = await Promise.all([
    db.prepare(sql).bind(since, bucketMs, until).all(), edge('<', 'DESC', since), edge('>', 'ASC', until)]);
  return { since, until, bucketMs, points: results, before, after };
}
