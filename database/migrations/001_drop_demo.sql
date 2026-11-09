-- Production migration v1: drop the prototype demo flag and demo rows.
-- Apply AFTER schema.sql on existing databases:
--   psql $DATABASE_URL -f database/migrations/001_drop_demo.sql
ALTER TABLE projects DROP COLUMN IF EXISTS is_demo;

DELETE FROM flood_history WHERE source = 'demo';
-- Demo share tokens were predictable (demo-token-A/B/C). Real tokens use sh_ prefix.
DELETE FROM project_sites WHERE project_id IN (SELECT id FROM projects WHERE share_token LIKE 'demo-token-%');
DELETE FROM environmental_factors WHERE project_id IN (SELECT id FROM projects WHERE share_token LIKE 'demo-token-%');
DELETE FROM projects WHERE share_token LIKE 'demo-token-%';
DELETE FROM users WHERE email = 'demo@floodshield.ai';
