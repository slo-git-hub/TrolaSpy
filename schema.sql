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

-- Photos pinned on the map. Images live in R2 under photos/<id>.jpg and photos/<id>_t.jpg.
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
  created_by TEXT
);
