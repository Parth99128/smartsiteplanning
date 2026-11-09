-- Migration 006: point assets (recharge pits, storage sumps, pump rooms).
-- Unlike site_zones (polygons), assets are map pins with an optional capacity
-- (sump volume m³). Counts/capacities feed the BOQ automatically.
-- Apply: psql $DATABASE_URL -f database/migrations/006_site_assets.sql

CREATE TABLE IF NOT EXISTS site_assets (
  id SERIAL PRIMARY KEY,
  project_id INT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('recharge_pit', 'sump', 'pump')),
  name TEXT NOT NULL DEFAULT '' CHECK (char_length(name) <= 120),
  lat DOUBLE PRECISION NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lng DOUBLE PRECISION NOT NULL CHECK (lng BETWEEN -180 AND 180),
  capacity_m3 FLOAT CHECK (capacity_m3 IS NULL OR capacity_m3 >= 0),
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_assets_proj ON site_assets(project_id);
