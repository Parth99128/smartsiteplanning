-- Production migration 002: red flags, factor ratings, resilience breakdown,
-- land-use + catchment factors, site zones, site plans.
-- Apply: docker exec -i climate-db-1 psql -U floodshield -d floodshield < database/migrations/002_production_features.sql

-- 1. Interpretation artefacts on each assessment (replaces ad-hoc demo text)
ALTER TABLE risk_assessments
  ADD COLUMN IF NOT EXISTS flags JSONB,
  ADD COLUMN IF NOT EXISTS factor_ratings JSONB,
  ADD COLUMN IF NOT EXISTS resilience_breakdown JSONB,
  ADD COLUMN IF NOT EXISTS run_type TEXT DEFAULT 'analysis'
    CHECK (run_type IN ('analysis', 'simulation', 'apply_all'));

-- 2. New model inputs (task.md: land-use change, catchment characteristics)
ALTER TABLE environmental_factors
  ADD COLUMN IF NOT EXISTS land_use_change_pct FLOAT
    CHECK (land_use_change_pct IS NULL OR (land_use_change_pct >= 0 AND land_use_change_pct <= 100)),
  ADD COLUMN IF NOT EXISTS catchment_sqm FLOAT
    CHECK (catchment_sqm IS NULL OR (catchment_sqm >= 0 AND catchment_sqm <= 2000000));

-- Backfill existing rows deterministically from stored impervious/dist values
-- (documented geo-estimate, same formula family as the backend estimator).
UPDATE environmental_factors
SET land_use_change_pct = LEAST(95, GREATEST(5, COALESCE(impervious_pct, 65) * 0.8)),
    catchment_sqm = LEAST(2000000, GREATEST(5000, COALESCE(dist_water_m, 120) * 400))
WHERE land_use_change_pct IS NULL OR catchment_sqm IS NULL;

ALTER TABLE environmental_factors
  ALTER COLUMN land_use_change_pct SET DEFAULT 50,
  ALTER COLUMN catchment_sqm SET DEFAULT 48000;

-- 3. User-tagged site zones (building, parking, road, open_space, drainage, green)
CREATE TABLE IF NOT EXISTS site_zones (
  id SERIAL PRIMARY KEY,
  project_id INT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('building', 'parking', 'road', 'open_space', 'drainage', 'green')),
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  polygon JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_zones_proj ON site_zones(project_id);

-- 4. Uploaded site-plan images with user-calibrated bounds
CREATE TABLE IF NOT EXISTS site_plans (
  id SERIAL PRIMARY KEY,
  project_id INT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  image BYTEA NOT NULL,
  sw_lat DOUBLE PRECISION NOT NULL,
  sw_lng DOUBLE PRECISION NOT NULL,
  ne_lat DOUBLE PRECISION NOT NULL,
  ne_lng DOUBLE PRECISION NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_plans_proj ON site_plans(project_id);
