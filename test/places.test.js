import { test } from 'node:test';
import assert from 'node:assert/strict';
import { d1 } from './d1.js';
import { describe, placeNames, cellOf } from '../shared/places.js';
import { findStays, nightsIn } from '../shared/stays.js';
import { trolaServer } from '../mcp/src/tools.js';

// Shaped like Nominatim's jsonv2 reverse answers (made-up places).
const camp = { category: 'tourism', type: 'camp_site', name: 'Camping Lipa',
  display_name: 'Camping Lipa, Cesta 5, Lipa, Slovenia', address: { tourism: 'Camping Lipa', road: 'Cesta', village: 'Lipa', country: 'Slovenia' } };
const charger = { category: 'amenity', type: 'charging_station', name: '', extratags: { brand: 'Ionity' },
  display_name: 'Via Roma, Verona, Italy', address: { road: 'Via Roma', city: 'Verona', country: 'Italy' } };
const road = { category: 'highway', type: 'residential', name: 'Via Roma', address: { road: 'Via Roma', town: 'Bardolino', country: 'Italy' } };

test('place names read well aloud', () => {
  assert.equal(describe(camp).label, 'Camping Lipa, Lipa, Slovenia');
  assert.equal(describe(charger).label, 'Ionity charger, Verona, Italy');
  assert.equal(describe({ ...charger, name: 'Tesla Supercharger' }).label, 'Tesla Supercharger, Verona, Italy');
  assert.equal(describe(road).label, 'Bardolino, Italy');
  assert.equal(describe({ ...camp, name: 'Lipa' }).label, 'Lipa, Slovenia');
  assert.deepEqual(describe({ error: 'Unable to geocode' }), { label: null, locality: null, country: null });
});

const fakeNominatim = (answers) => {
  const asked = [];
  const fetchFn = async (url, init) => {
    const u = new URL(url);
    asked.push({ lat: u.searchParams.get('lat'), ua: init.headers['user-agent'] });
    const a = answers[`${u.searchParams.get('lat')},${u.searchParams.get('lon')}`];
    return a === 429 ? new Response('busy', { status: 429 }) : Response.json(a || { error: 'Unable to geocode' });
  };
  return { asked, fetchFn };
};

test('each spot is looked up once, a few at a time', async () => {
  const db = d1();
  const n = fakeNominatim({ '46.100,14.200': camp, '45.400,10.990': charger });
  const opts = { fetchFn: n.fetchFn, gap: 1 };
  // Two readings of the same spot (within ~100 m) make one lookup.
  let names = await placeNames(db, [{ lat: 46.10012, lon: 14.20031 }, { lat: 46.09981, lon: 14.19968 }, { lat: 45.4, lon: 10.99 }, null], opts);
  assert.equal(n.asked.length, 2);
  assert.match(n.asked[0].ua, /^TrolaSpy\//);
  assert.equal(names.get(cellOf({ lat: 46.1, lon: 14.2 })).label, 'Camping Lipa, Lipa, Slovenia');
  names = await placeNames(db, [{ lat: 46.1, lon: 14.2 }, { lat: 45.4, lon: 10.99 }], opts);
  assert.equal(n.asked.length, 2, 'kept from the first time');
  assert.equal(names.size, 2);

  // Open sea: kept as nameless, not asked again.
  names = await placeNames(db, [{ lat: 43, lon: 13 }], opts);
  assert.equal(names.get('43.000,13.000').label, null);
  await placeNames(db, [{ lat: 43, lon: 13 }], opts);
  assert.equal(n.asked.length, 3);

  // At most `max` now; the rest after answering.
  const spots = [1, 2, 3, 4].map((i) => ({ lat: 40 + i, lon: 10 }));
  const later = [];
  names = await placeNames(db, spots, { ...opts, max: 1, later: (p) => later.push(p) });
  assert.equal(names.size, 1);
  await Promise.all(later);
  assert.equal(n.asked.length, 3 + 4);

  // Refused: nothing kept, so it is asked again next time.
  const busy = fakeNominatim({ '47.000,15.000': 429 });
  names = await placeNames(db, [{ lat: 47, lon: 15 }], { fetchFn: busy.fetchFn, gap: 1 });
  assert.equal(names.size, 0);
  await placeNames(db, [{ lat: 47, lon: 15 }], { fetchFn: busy.fetchFn, gap: 1 });
  assert.equal(busy.asked.length, 2);
});

test('stays: 20 minutes within 150 m, still there at the end, nights over 3 a.m.', () => {
  const m = 60000, at = (ts, lat) => ({ ts, lat, lon: 14 });
  const pts = [at(0, 46), at(10 * m, 46.0005), at(30 * m, 46.001), at(31 * m, 46.05), at(40 * m, 46.1)];
  assert.deepEqual(findStays(pts).map((s) => [s.start, s.end]), [[0, 30 * m]]);
  const live = findStays(pts, 100 * m);
  assert.deepEqual(live.map((s) => [s.start, s.end, !!s.ongoing]), [[0, 30 * m, false], [40 * m, 100 * m, true]]);
  const t = (iso) => Date.parse(iso);
  assert.equal(nightsIn(t('2026-10-12T18:00:00Z'), t('2026-10-13T07:00:00Z'), 'Europe/Ljubljana'), 1); // 3 a.m. there is 01:00 UTC
  assert.equal(nightsIn(t('2026-10-13T02:00:00Z'), t('2026-10-13T07:00:00Z'), 'Europe/Ljubljana'), 0);
  assert.equal(nightsIn(t('2026-10-10T18:00:00Z'), t('2026-10-13T07:00:00Z'), 'Europe/Ljubljana'), 3);
});

test('ChatGPT hears where Trola stopped, slept and charged', async () => {
  const db = d1();
  // A made-up trip in Slovenia (UTC+2): Mon 12 Oct drive A → B, a stop with a charge at B, on to C
  // for the night; Tue 13 Oct on to D, parked there since 10:00.
  const T = (d, hm) => Date.parse(`2026-10-${d}T${hm}:00+02:00`);
  const P = { A: [46.0, 14.5], B: [46.2, 14.3], C: [46.1, 14.2], D: [45.9, 13.9] };
  const rows = [];
  const drive = (from, to, t0, t1) => { for (let t = t0; t <= t1; t += 60000) { const f = (t - t0) / (t1 - t0);
    rows.push([t, P[from][0] + (P[to][0] - P[from][0]) * f, P[from][1] + (P[to][1] - P[from][1]) * f, t === t1 ? 0 : 60]); } };
  drive('A', 'B', T(12, '08:00'), T(12, '10:00'));
  drive('B', 'C', T(12, '10:45'), T(12, '12:00'));
  drive('C', 'D', T(13, '09:00'), T(13, '10:00'));
  const ins = db.sqlite.prepare('INSERT INTO readings (ts, lat, lon, speed, soc, gids, odo) VALUES (?, ?, ?, ?, 80, 200, 50000)');
  for (const r of rows) ins.run(...r);
  db.sqlite.prepare('INSERT INTO charges (start_ts, end_ts, lat, lon, kwh, max_kw, soc_start, soc_end, mode) VALUES (?, ?, ?, ?, 12.4, 46, 30, 70, 3)')
    .run(T(12, '10:05'), T(12, '10:40'), ...P.B);
  db.sqlite.prepare("INSERT INTO settings (key, value) VALUES ('charges_through', ?)").run(String(T(13, '12:00')));
  const n = fakeNominatim({ '46.200,14.300': charger, '46.100,14.200': camp, '45.900,13.900': road });
  const server = trolaServer(db, { now: () => T(13, '15:00') });
  globalThis.fetch = n.fetchFn; // the tools call the real service through fetch
  const call = (name, args = {}) => server.tools.find((t) => t.name === name).run(args);

  const s = await call('get_trola_stops', { from: 'yesterday', to: 'today' });
  assert.deepEqual(s.data.stays.map((x) => [x.kind, x.minutes, x.place, x.still_there]), [
    ['stop', 45, 'Ionity charger, Verona, Italy', false],
    ['night', 21 * 60, 'Camping Lipa, Lipa, Slovenia', false],
    ['stop', 5 * 60, 'Bardolino, Italy', true],
  ]);
  assert.equal(s.data.stays[0].charged_kwh, 12.4);
  assert.match(s.text, /1 overnight stay and 2 stops/);
  assert.match(s.text, /Mon 12 Oct 12:00 to Tue 13 Oct 09:00 \(21 h\): night at Camping Lipa, Lipa, Slovenia\./);
  assert.match(s.text, /Since Tue 13 Oct 10:00, still there \(5 h so far\): parked at Bardolino, Italy\./);
  assert.match(s.text, /stop at Ionity charger, Verona, Italy, charged 12\.4 kWh\./);

  const c = await call('get_trola_charges', { from: 'Monday' });
  assert.match(c.text, /DC fast charge, 12\.4 kWh, 30% to 70%, up to 46 kW, at Ionity charger, Verona, Italy\./);
  assert.equal(c.data.sessions[0].maps_url, 'https://www.google.com/maps?q=46.20000,14.30000');

  const st = await call('get_trola_status');
  assert.match(st.text, /parked at Bardolino, Italy\./);
  assert.equal(n.asked.length, 3, 'each spot looked up once');
});
