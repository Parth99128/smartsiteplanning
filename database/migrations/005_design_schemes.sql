-- Migration 005: design schemes (architect optioneering A/B/C per site).
-- A scheme snapshots one simulator input + its scored result so options can be
-- compared side by side and reloaded into the simulator. Cap: 6 per project.
-- Apply: psql $DATABASE_URL -f database/migrations/005_design_schemes.sql

CREATE TABLE IF NOT EXISTS design_schemes (
  id SERIAL PRIMARY KEY,
  project_id INT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
  input JSONB NOT NULL,
  result JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_schemes_proj ON design_schemes(project_id);
