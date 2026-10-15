-- One row per LeafSpy upload. ts is the server receive time in ms since epoch.
CREATE TABLE IF NOT EXISTS readings (
  ts         INTEGER PRIMARY KEY,
  lat        REAL,
  lon        REAL,
  elv        REAL,
  speed      REAL,     -- km/h
  soc        REAL,     -- %
  gids       INTEGER,
  soh        REAL,     -- %
  ahr        REAL,
  hx         REAL,
  bat_volts  REAL,
  bat_amps   REAL,
  bat_temp   REAL,     -- °C
  amb_temp   REAL,     -- °C
  plug_state INTEGER,  -- 0 unplugged, 1 partial, 2 plugged
  chrg_mode  INTEGER,  -- 0 none, 1 L1, 2 L2, 3 quick charge
  chrg_pwr   REAL,     -- W
  pwr_sw     INTEGER,  -- 1 car on
  odo        INTEGER,  -- km
  trip       INTEGER,
  seq        INTEGER,
  dev_bat    INTEGER,  -- tablet battery %
  rpm        INTEGER
);

-- Photos and videos pinned on the map. Images live in R2 under photos/<id>.jpg and photos/<id>_t.jpg;
-- a video adds photos/<id>.mp4 (the .jpg is then a frame from it).
CREATE TABLE IF NOT EXISTS photos (
  id         TEXT PRIMARY KEY,
  taken_ts   INTEGER,  -- ms since epoch, from EXIF when available
  lat        REAL NOT NULL,
  lon        REAL NOT NULL,
  source     TEXT,     -- exif | track | manual
  caption    TEXT,
  width      INTEGER,
  height     INTEGER,
  created_ts INTEGER NOT NULL,
  created_by TEXT,
  duration   REAL,     -- seconds, for a video; NULL for a photo
  orig_name  TEXT,     -- the original file's name and size, to spot it if it is added again
  orig_size  INTEGER
);

-- Finished charging sessions, copied from readings daily so they are kept after 30 days.
CREATE TABLE IF NOT EXISTS charges (
  start_ts   INTEGER PRIMARY KEY,
  end_ts     INTEGER NOT NULL,
  lat        REAL,
  lon        REAL,
  kwh        REAL,     -- into the battery
  charge_ms  INTEGER,  -- time current was flowing in
  max_kw     REAL,
  soc_start  REAL,
  soc_end    REAL,
  mode       INTEGER   -- highest ChrgMode seen: 3 = quick charge (DC)
);

-- One summary row per finished UTC day (monthly view, battery health). Rebuilt when readings change.
CREATE TABLE IF NOT EXISTS daily (
  day         TEXT PRIMARY KEY,  -- YYYY-MM-DD
  readings    INTEGER,
  distance_km REAL,
  drive_s     REAL,
  used_kwh    REAL,
  regen_kwh   REAL,
  charged_kwh REAL,
  charges     INTEGER,
  max_speed   REAL,
  soh         REAL,  -- daily averages
  hx          REAL,
  ahr         REAL,
  amb_min     REAL,
  amb_max     REAL,
  computed_ts INTEGER,
  max_regen_kw REAL   -- strongest regen while driving
);

-- Victron totals per finished UTC day, so the month bars don't re-read every reading.
CREATE TABLE IF NOT EXISTS victron_days (
  day        TEXT PRIMARY KEY,  -- YYYY-MM-DD
  solar_wh   INTEGER,           -- the solar charger's own total for the day
  dcdc_on_ms INTEGER            -- how long the DC-DC charger ran
);

-- Admin settings and alert state, as JSON values.
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- Victron solar charger and DC-DC charger, from their Bluetooth broadcasts (TrolaSpy Bridge app).
-- A row is kept when something changed, or every 15 minutes when nothing did.
CREATE TABLE IF NOT EXISTS victron (
  kind       TEXT NOT NULL,     -- 'solar' or 'dcdc'
  ts         INTEGER NOT NULL,  -- ms since epoch
  state      INTEGER,           -- charge stage (VE.Direct device state)
  error      INTEGER,
  batt_v     REAL,              -- solar: leisure battery volts, charge amps, panel watts, today's yield
  batt_a     REAL,
  pv_w       INTEGER,
  yield_wh   INTEGER,
  in_v       REAL,              -- DC-DC: input (van battery) and output volts, why it's off
  out_v      REAL,
  off_reason INTEGER,
  PRIMARY KEY (kind, ts)
);

-- Place names for spots Trola charged or stayed at, from OpenStreetMap (Nominatim), so each spot
-- (rounded to about 100 m) is looked up only once.
CREATE TABLE IF NOT EXISTS places (
  cell     TEXT PRIMARY KEY,  -- 'lat,lon' to 3 decimals
  label    TEXT,              -- e.g. 'Camping Bled, Bled, Slovenia'; NULL if nothing is there (open sea)
  locality TEXT,
  country  TEXT,
  ts       INTEGER            -- when it was looked up
);
