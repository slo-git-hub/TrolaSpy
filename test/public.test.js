import { test } from 'node:test';
import assert from 'node:assert/strict';
import { roughArea, DETAIL_KM } from '../shared/public.js';

// Distance in metres between two points (haversine).
function dist(a, b) {
  const r = (d) => (d * Math.PI) / 180;
  const h = Math.sin(r(b.lat - a.lat) / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lon - a.lon) / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}

test('the rough area always contains the van but never pinpoints it', () => {
  for (const km of Object.values(DETAIL_KM)) {
    for (let i = 0; i < 2000; i++) {
      const p = { lat: 35 + Math.random() * 30, lon: -10 + Math.random() * 40 };
      const a = roughArea(p.lat, p.lon, km);
      assert.ok(dist(p, a) <= a.radius_m, `outside the circle: ${JSON.stringify({ p, a })}`);
    }
  }
});

test('nearby spots in the same cell give the same area', () => {
  const a = roughArea(46.0569, 14.5058, 5);
  const b = roughArea(46.0571, 14.5061, 5);
  assert.deepEqual(a, b);
  assert.equal(a.radius_m, 3750);
});
