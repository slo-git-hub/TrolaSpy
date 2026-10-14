// What Trola is doing now: the newest LeafSpy reading (with gaps filled from earlier ones), the
// time zone where it is, and the leisure battery from the Victron chargers. Used by the map page
// and the ChatGPT connector.
import tzlookup from '@photostructure/tz-lookup';
import { leisureCharge, HELD, CHARGING_A } from './lifepo4.js';
import { RUN_GAP_MS } from './victron-days.js';

// The time zone at a spot (IANA name, such as Europe/Ljubljana).
export const timeZoneAt = (p) => { try { return p && p.lat !== null ? tzlookup(p.lat, p.lon) : null; } catch { return null; } };

// Values only the car itself can give. When it doesn't answer (just after it is switched off)
// LeafSpy sends nothing or 0 for them, so the last ones it did give are shown instead. Each
// group comes from the newest reading that has its first value.
const CAR_FIELDS = [['soc', 'gids', 'bat_temp', 'amb_temp'], ['soh', 'hx', 'ahr'], ['odo']];
const missing = (k, v) => v === null || v === undefined || (v === 0 && !k.endsWith('_temp'));
// While charging, LeafSpy sometimes gets no battery current from the car and sends 0. The
// newest current measured in the last CHARGE_FILL_MS of the charge is shown instead.
const CHARGE_FILL_MS = 20 * 60 * 1000;

export async function latestReading(db) {
  const row = await db.prepare('SELECT * FROM readings ORDER BY ts DESC LIMIT 1').first();
  for (const group of row ? CAR_FIELDS : []) {
    if (!group.some((k) => missing(k, row[k]))) continue;
    const known = await db.prepare(`SELECT ${group.join(', ')} FROM readings WHERE ${group[0]} > 0 ORDER BY ts DESC LIMIT 1`).first();
    if (known) for (const k of group) if (missing(k, row[k]) && !missing(k, known[k])) row[k] = known[k];
  }
  if (row && row.chrg_mode > 0 && !(row.bat_volts * row.bat_amps)) {
    const known = await db.prepare(
      `SELECT bat_volts, bat_amps FROM readings
        WHERE ts >= ? AND ts < ? AND chrg_mode > 0 AND bat_volts * bat_amps < 0 ORDER BY ts DESC LIMIT 1`
    ).bind(row.ts - CHARGE_FILL_MS, row.ts).first();
    Object.assign(row, known || { bat_amps: null });
  }
  // Last known position, in case the newest upload had no GPS fix.
  const pos = row && row.lat === null
    ? await db.prepare('SELECT ts, lat, lon FROM readings WHERE lat IS NOT NULL ORDER BY ts DESC LIMIT 1').first()
    : null;
  return { reading: row, lastPosition: pos, tz: timeZoneAt(pos || row) };
}

// Newest rows of both chargers, and the leisure battery's charge worked out from them (see lifepo4.js).
export async function victronNow(db, now = Date.now()) {
  const one = (kind) => db.prepare('SELECT * FROM victron WHERE kind = ? ORDER BY ts DESC LIMIT 1').bind(kind).first();
  const [solar, dcdc, rest] = await Promise.all([
    one('solar'), one('dcdc'),
    // The leisure battery's newest voltage while neither charger was charging it (last 24 h).
    db.prepare(`SELECT ts, batt_v FROM victron s
                 WHERE kind = 'solar' AND ts >= ?1 AND batt_v > 0 AND COALESCE(batt_a, 0) < ${CHARGING_A} AND COALESCE(state, 0) NOT IN (${HELD.join(', ')})
                   AND COALESCE((SELECT state FROM victron d WHERE d.kind = 'dcdc' AND d.ts <= s.ts AND d.ts > s.ts - ?2
                                   ORDER BY d.ts DESC LIMIT 1), 0) = 0
                 ORDER BY ts DESC LIMIT 1`).bind(now - 864e5, RUN_GAP_MS).first(),
  ]);
  return { solar, dcdc, leisure: leisureCharge(solar, dcdc, rest) };
}
