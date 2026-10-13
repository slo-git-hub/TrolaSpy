import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lifepo4Percent, leisureCharge, LEISURE_AH } from '../shared/lifepo4.js';

test('LiFePO4 voltage maps to a charge level along the usual table', () => {
  assert.equal(lifepo4Percent(13.6), 100);
  assert.equal(lifepo4Percent(14.2), 100);
  assert.equal(lifepo4Percent(13.1), 50);
  assert.equal(lifepo4Percent(13.15), 55);
  assert.equal(lifepo4Percent(12.8), 20);
  assert.equal(lifepo4Percent(9.5), 0);
  assert.equal(lifepo4Percent(null), null);
  assert.equal(lifepo4Percent(0), null);
});

test('the estimate uses the voltage only while nothing charges the battery', () => {
  const sol = { ts: 1e6, state: 0, batt_v: 13.1, batt_a: 0 };
  assert.deepEqual(leisureCharge(sol, null, null), { percent: 50, ah: LEISURE_AH / 2, capacity_ah: LEISURE_AH, basis: 'now', ts: 1e6, by: undefined });
  // A trickle of solar at dawn doesn't count as charging.
  assert.equal(leisureCharge({ ...sol, state: 3, batt_a: 0.5 }, null, null).basis, 'now');
  // Solar charging: the voltage before it is used.
  const rest = { ts: 5e5, batt_v: 13.0 };
  assert.equal(leisureCharge({ ...sol, state: 3, batt_v: 13.6, batt_a: 6 }, null, rest).basis, 'rest');
  assert.equal(leisureCharge({ ...sol, state: 3, batt_v: 13.6, batt_a: 6 }, null, rest).percent, 40);
  // DC-DC on at the same time, no voltage from before: unknown.
  assert.equal(leisureCharge({ ...sol, batt_v: 14.1 }, { ts: 1e6, state: 3 }, null).percent, null);
  // An old DC-DC reading doesn't count.
  assert.equal(leisureCharge(sol, { ts: 1e6 - 3600e3, state: 3 }, rest).basis, 'now');
  // Float on either charger: full.
  assert.equal(leisureCharge({ ...sol, state: 5, batt_v: 13.5 }, null, rest).percent, 100);
  assert.equal(leisureCharge({ ...sol, batt_v: 13.5 }, { ts: 1e6, state: 5 }, rest).by, 'dcdc');
  assert.equal(leisureCharge(null, null, null), null);
});
