// Place names for spots (where Trola charged, stayed, or is now) from OpenStreetMap's Nominatim.
// Each spot, rounded to about 100 m, is looked up once and kept in the `places` table: Nominatim
// asks for at most one request a second, an application User-Agent, and caching.
// https://operations.osmfoundation.org/policies/nominatim/
const NOMINATIM = 'https://nominatim.openstreetmap.org';
const USER_AGENT = 'TrolaSpy/1.0 (+https://github.com/slo-git-hub/TrolaSpy)';
const GAP_MS = 1100; // between lookups
export const ATTRIBUTION = 'Place names © OpenStreetMap contributors (ODbL)';

export const cellOf = (p) => `${p.lat.toFixed(3)},${p.lon.toFixed(3)}`;
export const mapsUrl = (p) => `https://www.google.com/maps?q=${p.lat.toFixed(5)},${p.lon.toFixed(5)}`;

// Objects worth naming at a spot (a campsite, a charging station, a shop), not a road or a house.
const NAMED = ['amenity', 'tourism', 'shop', 'leisure', 'natural', 'historic', 'man_made', 'aeroway', 'railway'];

// A Nominatim jsonv2 reverse result → { label, locality, country }, e.g.
// { label: 'Camping Bled, Bled, Slovenia', locality: 'Bled', country: 'Slovenia' }.
export function describe(j) {
  if (!j || j.error) return { label: null, locality: null, country: null };
  const a = j.address || {};
  const locality = a.city || a.town || a.village || a.hamlet || a.suburb || a.municipality || a.county || a.state || null;
  const x = j.extratags || {};
  let poi = NAMED.includes(j.category) ? j.name || (j.type === 'charging_station' ? x.brand || x.operator : null) || null : null;
  if (poi && j.type === 'charging_station' && !/charg|lad|polni|ricar|recharg/i.test(poi)) poi = `${poi} charger`;
  const country = a.country || null;
  const parts = [poi, locality, country].filter((v, i, all) => v && all.indexOf(v) === i);
  return { label: parts.join(', ') || j.display_name || null, locality, country };
}

// spots: [{ lat, lon }]. Returns a Map of cellOf(spot) → { label, locality, country } for the spots
// looked up (label is null where there is nothing to name, such as open sea). Looks up at most
// `max` new spots now; with `later` (ctx.waitUntil) up to `more` others after the answer has gone,
// so the next question has their names.
export async function placeNames(db, spots, { max = 3, more = 8, later = null, base = NOMINATIM, fetchFn = fetch, gap = GAP_MS } = {}) {
  const cells = [...new Set(spots.filter((p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lon)).map(cellOf))];
  const names = new Map();
  for (let i = 0; i < cells.length; i += 90) { // D1 binds at most 100 values a query
    const part = cells.slice(i, i + 90);
    const { results } = await db.prepare(`SELECT cell, label, locality, country FROM places WHERE cell IN (${part.map(() => '?').join(', ')})`)
      .bind(...part).all();
    for (const r of results) names.set(r.cell, r);
  }
  const missing = cells.filter((c) => !names.has(c));
  const lookUp = async (list) => {
    for (const [i, cell] of list.entries()) {
      if (i) await new Promise((r) => setTimeout(r, gap));
      const [lat, lon] = cell.split(',');
      let j;
      try {
        const r = await fetchFn(`${base}/reverse?format=jsonv2&lat=${lat}&lon=${lon}&zoom=18&addressdetails=1&extratags=1&accept-language=en`,
          { headers: { 'user-agent': USER_AGENT, accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
        if (!r.ok) break; // busy or refused: try again another time
        j = await r.json();
      } catch { break; }
      const d = describe(j);
      names.set(cell, { cell, ...d });
      await db.prepare('INSERT OR REPLACE INTO places (cell, label, locality, country, ts) VALUES (?, ?, ?, ?, ?)')
        .bind(cell, d.label, d.locality, d.country, Date.now()).run();
    }
  };
  await lookUp(missing.slice(0, max));
  if (later && missing.length > max) later(new Promise((r) => setTimeout(r, gap)).then(() => lookUp(missing.slice(max, max + more))).catch(() => {}));
  return names;
}
