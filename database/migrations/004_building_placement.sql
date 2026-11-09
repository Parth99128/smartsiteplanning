-- Migration 004: draggable proposed-building footprint (architect design loop).
-- The ML flow-path `building` bbox + 3D block + 2D overlay all follow this
-- normalized center. Default (0.475, 0.475) preserves the legacy fixed bbox
-- (x=0.35, y=0.35, w=d=0.25). Size stays driven by footprint_sqm.
-- Apply: psql $DATABASE_URL -f database/migrations/004_building_placement.sql

CREATE TABLE IF NOT EXISTS building_placement (
  project_id INT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  cx FLOAT NOT NULL DEFAULT 0.475 CHECK (cx >= 0 AND cx <= 1),
  cy FLOAT NOT NULL DEFAULT 0.475 CHECK (cy >= 0 AND cy <= 1),
  updated_at TIMESTAMPTZ DEFAULT now()
);
