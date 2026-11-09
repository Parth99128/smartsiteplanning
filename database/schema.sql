-- FloodShield AI schema (Postgres + PostGIS) — production v1
-- All tables are real persistence. No demo flags, no synthetic defaults in DDL.
CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT, created_at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE IF NOT EXISTS projects (
  id SERIAL PRIMARY KEY, user_id INT REFERENCES users(id) ON DELETE SET NULL,
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  share_token TEXT UNIQUE NOT NULL, created_at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE IF NOT EXISTS project_sites (
  project_id INT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  location GEOGRAPHY(Point,4326) NOT NULL, site_area_sqm FLOAT CHECK (site_area_sqm IS NULL OR site_area_sqm >= 0),
  footprint_sqm FLOAT CHECK (footprint_sqm IS NULL OR footprint_sqm >= 0),
  floors INT DEFAULT 1 CHECK (floors BETWEEN 1 AND 100),
  builtup_pct FLOAT CHECK (builtup_pct IS NULL OR (builtup_pct >= 0 AND builtup_pct <= 100)),
  green_sqm FLOAT, permeable_sqm FLOAT, soil_type TEXT, drainage_info TEXT
);
CREATE INDEX IF NOT EXISTS idx_sites_loc ON project_sites USING GIST ((location::geometry));
CREATE TABLE IF NOT EXISTS environmental_factors (
  project_id INT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  rainfall_mm FLOAT CHECK (rainfall_mm IS NULL OR (rainfall_mm >= 0 AND rainfall_mm <= 600)),
  elevation_m FLOAT, slope_deg FLOAT CHECK (slope_deg IS NULL OR (slope_deg >= 0 AND slope_deg <= 60)),
  dist_water_m FLOAT CHECK (dist_water_m IS NULL OR dist_water_m >= 0),
  drainage_density FLOAT, soil_infiltration_mmhr FLOAT,
  impervious_pct FLOAT CHECK (impervious_pct IS NULL OR (impervious_pct >= 0 AND impervious_pct <= 100)),
  footprint_sqm FLOAT, hist_flood_count INT DEFAULT 0 CHECK (hist_flood_count >= 0), plinth_m FLOAT DEFAULT 0.3,
  land_use_change_pct FLOAT DEFAULT 50 CHECK (land_use_change_pct IS NULL OR (land_use_change_pct >= 0 AND land_use_change_pct <= 100)),
  catchment_sqm FLOAT DEFAULT 48000 CHECK (catchment_sqm IS NULL OR (catchment_sqm >= 0 AND catchment_sqm <= 2000000))
);
CREATE TABLE IF NOT EXISTS flood_history (
  id SERIAL PRIMARY KEY, project_id INT REFERENCES projects(id) ON DELETE CASCADE,
  year INT CHECK (year BETWEEN 1900 AND 2100), depth_m FLOAT CHECK (depth_m >= 0), source TEXT
);
CREATE TABLE IF NOT EXISTS drainage_paths (
  project_id INT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  geom GEOGRAPHY(LineString,4326), intersects_building BOOLEAN DEFAULT false
);
CREATE TABLE IF NOT EXISTS heightmap_grids (
  project_id INT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  size INT CHECK (size BETWEEN 8 AND 256), cell_m FLOAT, payload JSONB
);
CREATE TABLE IF NOT EXISTS risk_assessments (
  id SERIAL PRIMARY KEY, project_id INT REFERENCES projects(id) ON DELETE CASCADE,
  risk_score FLOAT CHECK (risk_score BETWEEN 0 AND 100), risk_level TEXT, contributions JSONB, top_factors JSONB,
  resilience_score FLOAT CHECK (resilience_score IS NULL OR (resilience_score BETWEEN 0 AND 100)),
  badge TEXT, climate_uplift_pct FLOAT DEFAULT 0, created_at TIMESTAMPTZ DEFAULT now(),
  flags JSONB, factor_ratings JSONB, resilience_breakdown JSONB,
  run_type TEXT DEFAULT 'analysis' CHECK (run_type IN ('analysis', 'simulation', 'apply_all'))
);
CREATE INDEX IF NOT EXISTS idx_risk_proj ON risk_assessments(project_id);
CREATE INDEX IF NOT EXISTS idx_risk_proj_created ON risk_assessments(project_id, created_at DESC);
CREATE TABLE IF NOT EXISTS construction_designs (
  project_id INT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  footprint_sqm FLOAT, plinth_m FLOAT, storage_m3 FLOAT DEFAULT 0,
  rain_garden BOOLEAN DEFAULT false, permeable_sqm FLOAT
);
CREATE TABLE IF NOT EXISTS recommendations (
  id SERIAL PRIMARY KEY, project_id INT REFERENCES projects(id) ON DELETE CASCADE,
  problem TEXT, action TEXT, reason TEXT, effect TEXT, priority TEXT,
  cost_band TEXT, gain_pts FLOAT
);
CREATE TABLE IF NOT EXISTS simulation_results (
  id SERIAL PRIMARY KEY, project_id INT REFERENCES projects(id) ON DELETE CASCADE,
  input JSONB, risk_score FLOAT, resilience_score FLOAT, created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sim_proj_created ON simulation_results(project_id, created_at DESC);
CREATE TABLE IF NOT EXISTS site_zones (
  id SERIAL PRIMARY KEY,
  project_id INT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('building', 'parking', 'road', 'open_space', 'drainage', 'green')),
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  polygon JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_zones_proj ON site_zones(project_id);
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
