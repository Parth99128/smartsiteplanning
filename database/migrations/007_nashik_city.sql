-- Migration 007: register Nashik (OSM-hydro tier — no open municipal registry).
-- Drain geometry comes from OSM waterways (Godavari, canals, nalas) labelled
-- source=OSM-waterway-*. No diameters/inverts: hydraulics treats them as open
-- channels with documented proxies; confidence reflects the tier.
-- Apply: psql $DATABASE_URL -f database/migrations/007_nashik_city.sql

INSERT INTO cities(code, name, bbox_north, bbox_south, bbox_east, bbox_west, source) VALUES
  ('nashik','Nashik',20.12,19.88,73.97,73.63,'OSM-waterway-2026 (no open municipal registry)')
ON CONFLICT (code) DO UPDATE SET name=EXCLUDED.name, source=EXCLUDED.source,
  bbox_north=EXCLUDED.bbox_north, bbox_south=EXCLUDED.bbox_south,
  bbox_east=EXCLUDED.bbox_east, bbox_west=EXCLUDED.bbox_west;
