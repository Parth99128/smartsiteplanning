# Architecture
```
Browser (Vite :5173) → Spring Boot (:8080) → Postgres+PostGIS (:5432)
                           ↓
                      FastAPI ML (:8000) → rf_flood_model.pkl (required)
```
- Frontend renders 2D Leaflet + 3D R3F from the SAME `heightmap+flow_path` JSON persisted in `heightmap_grids.payload JSONB`. The twin never renders placeholder terrain.
- Projects, sites, factors, assessments, simulations, and recommendations all live in Postgres. No in-memory state.
- Simulator: sliders → backend `/simulate` → ML `/simulate` → scores + terrain persisted → 3D re-renders, Recharts animates.
- Report: frontend snapshots 3D canvas `toDataURL()` → backend share link `/r/{token}` (secure random `sh_` prefix).
- ML inference requires a trained bundle; missing/corrupt models return 503. Analytical terrain is explicitly labelled `synthetic` and only served with `allow_synthetic=true` (dev/CI).
- Training data lives in `ml-service/data/*.csv` (surveyed). Synthetic generation exists only behind `--synthetic`.
