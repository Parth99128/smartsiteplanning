# FloodShield AI — Implementation Plan (Phases 1-14)

## Phase 1 Foundation ✅ scaffolded
- `docker-compose.yml`, `.env.example`, CORS in backend + ml-service, Vite proxy.

## Phase 2 Database ✅ `database/schema.sql`
12 tables: users, projects, project_sites, environmental_factors, flood_history, drainage_paths, heightmap_grids, risk_assessments, construction_designs, recommendations, interventions, simulation_results + resilience_scores in risk_assessments.

## Phase 3 Site Analysis
Frontend `SiteForm` + `MapView (Leaflet)` → `POST /api/projects` → PostGIS `GEOGRAPHY(Point)`.

## Phase 4 Flood Risk Engine ⭐ TRAIN HERE
**Where to train: `ml-service/train.py` — Phase 4 only.**
- std laptop, no GPU: RandomForest is CPU-only, ~5000 rows trains in <30s, <500MB RAM.
- Command: `pip install -r requirements.txt; python train.py`
- Output: `ml-service/models/rf_flood_model.pkl` (+ scaler + meta.json).
- Features (12): rainfall_mm, elevation_m, slope_deg, dist_water_m, drainage_density, soil_infiltration_mmhr, impervious_pct, footprint_sqm, hist_flood_count, plinth_m, land_use_change_pct, catchment_sqm.
- API: `POST /predict` returns score 0-100, level, top_factors, contributions (for Advisory Panel).

## Phase 5 Flow-path + Heightmap
`ml-service/flow_path.py`: Perlin-noise DEM (64x64 default) → gradient-descent path → `heightmap JSON + polyline`. Single source of truth for 2D + 3D.

Payload:
```json
{"grid": [[..]], "size": 64, "cell_m": 5.0, "flow_path": [{"x":0,"y":0,"h":12.3}], "intersects": true, "outlet": {"x":1,"y":2}}
```

## Phase 5B 3D Scene (headline)
`frontend/src/three/Terrain3D.jsx`: R3F displaced plane + InstancedMesh particles + extruded building box (red/green) + OrbitControls + day/dusk + legend. Consumes Phase-5 payload only.

## Phase 6 Recommendations
Rule engine in `ml-service/app.py:/recommend` + `backend RecommendationService`.

## Phase 7 Simulator
Sliders → `POST /simulate` → live Recharts + same 3D scene + climate toggle +0/+10/+25%.

## Phase 8 Resilience 0-100 + Badge Bronze/Silver/Gold/Platinum.

## Phase 9 Dashboard, 10 Site overlay, 11 Advisory (grounded on contributions), 12 Multi-site, 13 Report PDF+JSON+share link, 14 Demo mode + premium visuals.

## Verify order
1→2→3→4(train)→5→5B→6→7→8→9→10→11→12→13→14.
