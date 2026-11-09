-- Migration 003: pilot-city drain registry + site context (real-data loop).
-- Apply: psql $DATABASE_URL -f database/migrations/003_city_drains.sql
-- Pilot cities: chennai, bengaluru, pune (OpenCity KML/KMZ, Public Domain).

CREATE TABLE IF NOT EXISTS cities (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  bbox_north DOUBLE PRECISION NOT NULL,
  bbox_south DOUBLE PRECISION NOT NULL,
  bbox_east DOUBLE PRECISION NOT NULL,
  bbox_west DOUBLE PRECISION NOT NULL,
  drain_count INT DEFAULT 0,
  inlet_count INT DEFAULT 0,
  source TEXT,
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS drain_lines (
  id TEXT PRIMARY KEY,
  city TEXT NOT NULL REFERENCES cities(code) ON DELETE CASCADE,
  geom GEOGRAPHY(LineString,4326) NOT NULL,
  kind TEXT NOT NULL DEFAULT 'storm'
    CHECK (kind IN ('storm','sewer','open_drain','nalla','canal','river','lake_link')),
  type_label TEXT,
  width_m FLOAT CHECK (width_m IS NULL OR width_m > 0),
  dia_mm INT CHECK (dia_mm IS NULL OR dia_mm > 0),
  invert_m FLOAT,
  status TEXT DEFAULT 'unknown',
  source TEXT NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_drains_city ON drain_lines(city);
CREATE INDEX IF NOT EXISTS idx_drains_geom ON drain_lines USING GIST ((geom::geometry));

CREATE TABLE IF NOT EXISTS drain_points (
  id TEXT PRIMARY KEY,
  city TEXT NOT NULL REFERENCES cities(code) ON DELETE CASCADE,
  geom GEOGRAPHY(Point,4326) NOT NULL,
  kind TEXT NOT NULL DEFAULT 'chamber'
    CHECK (kind IN ('chamber','inlet','outlet','stp','pump')),
  source TEXT NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_drainpts_city ON drain_points(city);
CREATE INDEX IF NOT EXISTS idx_drainpts_geom ON drain_points USING GIST ((geom::geometry));

CREATE TABLE IF NOT EXISTS site_contexts (
  project_id INT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  city TEXT REFERENCES cities(code),
  lat DOUBLE PRECISION NOT NULL,
  lng DOUBLE PRECISION NOT NULL,
  confidence FLOAT CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS gis_imports (
  city TEXT PRIMARY KEY REFERENCES cities(code) ON DELETE CASCADE,
  file_hash TEXT,
  features INT DEFAULT 0,
  inlets INT DEFAULT 0,
  imported_at TIMESTAMPTZ DEFAULT now()
);

-- Seed pilot city bboxes (generous metro bounds; refined per import).
INSERT INTO cities(code, name, bbox_north, bbox_south, bbox_east, bbox_west, source) VALUES
  ('chennai','Chennai',13.35,12.83,80.35,79.95,'GCC via OpenCity + ReclaimChennai'),
  ('bengaluru','Bengaluru',13.20,12.80,77.85,77.35,'KSRSAC-2022 via OpenCity + BWSSB'),
  ('pune','Pune',18.70,18.35,74.05,73.70,'PMC via OpenCity')
ON CONFLICT (code) DO UPDATE SET name=EXCLUDED.name, source=EXCLUDED.source;
