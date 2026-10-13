// Rough charge level of the 12 V LiFePO4 leisure battery from its voltage. LiFePO4 voltage is
// nearly flat between 20 and 90 %, so this is only a guide (give or take 10-15 %), and only
// while nothing charges it: a charger pushes the voltage up. A small load pulls it down a little.

export const LEISURE_AH = 200;

// Resting voltage → charge %, the usual 12 V (4 cell) LiFePO4 table.
const CURVE = [[10.0, 0], [12.0, 10], [12.8, 20], [12.9, 30], [13.0, 40], [13.1, 50], [13.2, 60],
  [13.3, 70], [13.4, 80], [13.5, 90], [13.6, 100]];

export function lifepo4Percent(volts) {
  if (volts === null || volts === undefined || !(volts > 0)) return null;
  if (volts <= CURVE[0][0]) return 0;
  for (let i = 1; i < CURVE.length; i++) {
    const [v1, p1] = CURVE[i], [v0, p0] = CURVE[i - 1];
    if (volts <= v1) return Math.round(p0 + ((volts - v0) / (v1 - v0)) * (p1 - p0));
  }
  return 100;
}

// Victron charger states. Float and storage: battery full, held there. Absorption: nearly full,
// voltage held up by the charger. HELD lists all three; while in them the voltage says nothing.
const FULL = [5, 6];
export const HELD = [4, 5, 6];
export const CHARGING_A = 2; // less solar current than this barely moves a 200 Ah battery's voltage
const FRESH_MS = 20 * 60 * 1000; // a DC-DC reading this close to the solar one counts as "at the same time"

// sol and dcdc: newest rows of each charger. rest: newest solar row taken while neither charged.
// Returns { percent, ah, capacity_ah, basis, ts, by }: basis 'now' (current voltage), 'full' (charger `by` is
// in float), 'rest' (charging now, so from the last voltage before it) or 'charging' (unknown).
export function leisureCharge(sol, dcdc, rest) {
  if (!sol || !(sol.batt_v > 0)) return null;
  const dcdcOn = !!(dcdc && dcdc.state > 0 && Math.abs(dcdc.ts - sol.ts) < FRESH_MS);
  const out = (percent, basis, ts, by) => ({ percent, ah: percent === null ? null : Math.round((LEISURE_AH * percent) / 100), capacity_ah: LEISURE_AH, basis, ts, by });
  if (FULL.includes(sol.state)) return out(100, 'full', sol.ts, 'solar');
  if (dcdcOn && FULL.includes(dcdc.state)) return out(100, 'full', sol.ts, 'dcdc');
  if (!(sol.batt_a >= CHARGING_A || dcdcOn || HELD.includes(sol.state))) return out(lifepo4Percent(sol.batt_v), 'now', sol.ts);
  if (rest && rest.batt_v > 0) return out(lifepo4Percent(rest.batt_v), 'rest', rest.ts);
  return out(null, 'charging', sol.ts);
}
