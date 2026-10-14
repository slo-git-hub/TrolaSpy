import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dashSoc, addSocPoint } from '../shared/soc.js';

test('maps LeafSpy SOC to the dashboard %', () => {
  assert.equal(dashSoc(35.3), 25); // the reading the default comes from
  assert.equal(dashSoc(100), 100);
  assert.ok(Math.abs(dashSoc(87.4) - 85.4) < 0.2); // close to LeafSpy near full
  assert.equal(dashSoc(13), 0); // the hidden reserve
  assert.equal(dashSoc(null), null);
  assert.equal(dashSoc(50, []), 50); // no readings: unchanged
});

test('more dashboard readings bend the scale', () => {
  const cal = addSocPoint(undefined, 90, 95);
  assert.deepEqual(cal, [[35.3, 25], [90, 95]]);
  assert.equal(dashSoc(90, cal), 95);
  assert.equal(dashSoc(95, cal), 97.5);
  assert.deepEqual(addSocPoint(cal, 36.4, 26), [[36.4, 26], [90, 95]]); // replaces a nearby one
});
