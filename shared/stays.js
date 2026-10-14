// Where Trola stood still: STOP_MS or more within NEAR_M, worked out from the track. A stay over
// 3 a.m. where it was counts as a night. The map page uses the same rules (findStays in page.html).
export const STOP_MS = 20 * 60000, NEAR_M = 150;

export const distM = (a, b) => {
  const k = Math.PI / 180, x = (b.lon - a.lon) * k * Math.cos(((a.lat + b.lat) / 2) * k), y = (b.lat - a.lat) * k;
  return Math.hypot(x, y) * 6371e3;
};

// points: { ts, lat, lon }, oldest first. With `until`, a stay at the last point lasts until then
// (Trola is still there, and LeafSpy sends nothing while the van is off); it is marked ongoing.
export function findStays(points, until = null) {
  const out = [];
  let g = null;
  const close = () => { if (g && g.end - g.start >= STOP_MS) out.push(g); };
  for (const p of points) {
    if (p.lat === null || p.lat === undefined) continue;
    if (g && distM(g, p) < NEAR_M) { g.end = p.ts; continue; }
    close();
    g = { lat: p.lat, lon: p.lon, start: p.ts, end: p.ts };
  }
  if (g && until !== null && until > g.end) { g.end = until; g.ongoing = true; }
  close();
  return out;
}

// How many 3 a.m.s in a time zone fall between two times.
export function nightsIn(a, b, tz) {
  let hourOf;
  try { hourOf = new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hourCycle: 'h23', timeZone: tz }); }
  catch { hourOf = new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hourCycle: 'h23', timeZone: 'UTC' }); }
  let k = 0;
  for (let t = Math.ceil(a / 3600e3) * 3600e3; t <= b; t += 3600e3) if (Number(hourOf.format(t)) === 3) k++;
  return k;
}
