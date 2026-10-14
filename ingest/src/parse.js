// Turns a LeafSpy server upload (query string) into a readings row.
// Field names follow LeafSpy's "Server" upload: user, pass, Lat, Long, SOC, Gids, ...

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const int = (v) => {
  const n = num(v);
  return n === null ? null : Math.round(n);
};

// LeafSpy's Speed is GPS speed in metres per second; store km/h.
const msToKmh = (v) => (v === null ? null : Math.round(v * 3.6 * 10) / 10);

const fToC = (f) => (f === null ? null : Math.round(((f - 32) * 5 / 9) * 10) / 10);

// LeafSpy sends a stand-in (87 for outside) when the car's computers don't answer, such as
// right after the car is switched off. Anything no car could really see is dropped.
const inRange = (v, min, max) => (v !== null && v >= min && v <= max ? v : null);

// The pack gets stand-ins too: 0 V while the car doesn't answer, and 2147483.75 A (a computer's
// largest whole number, in thousandths) just as the car switches on. Trola's pack runs at about
// 250-400 V and a few hundred amps at most.
const PACK_VOLTS = [150, 450];
const PACK_AMPS = [-500, 500];
const BAT_TEMP = [-40, 80], AMB_TEMP = [-45, 60]; // °C

export function parseReading(params, ts = Date.now()) {
  let lat = num(params.get('Lat'));
  let lon = num(params.get('Long'));
  // LeafSpy sends 0/0 (or nothing) until the tablet has a GPS fix.
  if (lat === null || lon === null || (lat === 0 && lon === 0) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    lat = null;
    lon = null;
  }

  const fahrenheit = (params.get('Tunits') || '').toUpperCase() === 'F';
  let batTemp = num(params.get('BatTemp'));
  let ambTemp = num(params.get('Amb'));
  if (fahrenheit) {
    batTemp = fToC(batTemp);
    ambTemp = fToC(ambTemp);
  }
  batTemp = inRange(batTemp, ...BAT_TEMP);
  ambTemp = inRange(ambTemp, ...AMB_TEMP);

  return {
    ts,
    lat,
    lon,
    elv: num(params.get('Elv')),
    speed: msToKmh(num(params.get('Speed'))),
    soc: num(params.get('SOC')) || null, // LeafSpy sometimes sends 0 before the car answers
    gids: int(params.get('Gids')) || null,
    soh: num(params.get('SOH')),
    ahr: num(params.get('AHr')),
    hx: num(params.get('Hx')),
    bat_volts: inRange(num(params.get('BatVolts')), ...PACK_VOLTS),
    bat_amps: inRange(num(params.get('BatAmps')), ...PACK_AMPS),
    bat_temp: batTemp,
    amb_temp: ambTemp,
    plug_state: int(params.get('PlugState')),
    chrg_mode: int(params.get('ChrgMode')),
    chrg_pwr: num(params.get('ChrgPwr')),
    pwr_sw: int(params.get('PwrSw')),
    odo: int(params.get('Odo')) || null, // 0 until the car answers
    trip: int(params.get('Trip')),
    seq: int(params.get('Seq')),
    dev_bat: int(params.get('DevBat')),
    rpm: int(params.get('RPM')),
  };
}

export const COLUMNS = Object.keys(parseReading(new URLSearchParams()));

// A stored reading (from a backup) held to the same limits as a new one.
export const checkValues = (r) => ({ ...r, odo: r.odo || null, bat_volts: inRange(r.bat_volts, ...PACK_VOLTS),
  bat_amps: inRange(r.bat_amps, ...PACK_AMPS), bat_temp: inRange(r.bat_temp, ...BAT_TEMP), amb_temp: inRange(r.amb_temp, ...AMB_TEMP) });
