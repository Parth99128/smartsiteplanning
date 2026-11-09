# API Contract (single source of truth)

Base: backend `:8080/api`, ml `:8000`.

Errors follow RFC-7807 (`code`, `message`, `traceId`). ML outages surface as `502 ML_SERVICE_UNAVAILABLE`; missing models as `503 MODEL_NOT_LOADED`.

## Backend → Frontend
- `POST /api/sites/estimate` {lat, lng, footprint_sqm?} → {lat, lng, factors{12}, provenance} — detect ground at any map pin, no project needed
- `GET /api/cities` → pilot registries [{code, name, bbox_*, drain_count, inlet_count, source}] (empty until GIS import)
- `POST /api/sites/context` {lat, lng, radius_m?=500} → {city, confidence, factors{dist_water_m,drainage_density}, provenance, drains[{id,kind,type,dia_mm,width_m,status,dist_m,geom[[nx,ny]...]}], inlets[{id,kind,dist_m,lat,lng,x,y}], burn_lines[{pts,depth_m}], segments[{id,dia_mm?,width_m?,kind?,status?}], warnings} — measured registry, null city outside pilots
- `GET /api/projects/{id}/site-context` → stored context from last analysis, else live build
- `POST /api/projects` {name, lat, lng, site_area_sqm?, footprint_sqm?, floors?, builtup_pct?, green_sqm?, permeable_sqm?, soil_type?, drainage_info?, environmental_factors?} → full project (validated; 400 on bad geo). Factors are geo-derived per coordinate when not supplied.
- `GET /api/projects` → list with latest risk + resilience + badge (empty array when no projects)
- `GET /api/projects/{id}` → full detail incl. factors + heightmap + assessments + recommendations
- `PUT /api/projects/{id}/site` {lat, lng} → updated project (map moves persist, geo factors re-derived)
- `POST /api/projects/{id}/analyze` → ML `/predict` + `/flowpath` + `/resilience`; persists risk, red_flags, factor_ratings, resilience_breakdown, placed recommendations, downstream
- `POST /api/projects/{id}/simulate` {footprint_sqm?, plinth_m?, permeable_sqm?, storage_m3?, rain_garden?, recharge?, green_sqm?, land_use_change_pct?, catchment_sqm?, climate_uplift_pct?} → {risk_score, resilience_score, badge, resilience_breakdown, red_flags, factor_ratings, downstream, contributions, heightmap}
- `GET /api/projects/{id}/recommendations` → stored recommendations with map placement, else live ML call
- `POST /api/projects/{id}/recommendations/apply` {dry_run=true} → {before, after, applied[]} — one-click recommended design; dry_run=false persists it
- `GET/POST/DELETE /api/projects/{id}/zones` → site-zone tagging ({kind, name, polygon}) — polygons any ≥3 vertices
- `GET/POST/DELETE /api/projects/{id}/assets[/{assetId}]` {kind: recharge_pit|sump|pump, name, lat, lng, capacity_m3?} → point assets feeding the BOQ
- `GET /api/projects/{id}/zone-conflicts` → zones intersecting the traced flow path
- `GET/PUT /api/projects/{id}/placement` {cx, cy 0..1} → draggable proposed-block center; `/analyze` traces flow against this bbox (default 0.475,0.475 = legacy position)
- `/analyze` also returns `shift_guidance` {needed, feasible, distance_m, compass, dx_m, dy_m, new_cx, new_cy, message} — nearest-clear repositioning ("move 64 m east") at ≥12 m flow clearance, one click to apply
- `GET/POST/DELETE /api/projects/{id}/schemes[/{schemeId}]` {name, input} → design schemes A/B/C (cap 6): each re-scored server-side via the simulate pipeline without touching simulation history; stores slim {risk, resilience, badge, breakdown, flag_count}
- `GET/POST/DELETE /api/projects/{id}/site-plans` + `GET /api/site-plans/{planId}/image` → plan image upload (≤5 MB) aligned to site extent
- `POST /api/projects/{id}/report` → {project_id, share_token, share_url, report{analysis, zones, zone_conflicts, downstream}, formats}
- `GET /api/public/{token}` → read-only project + analysis + recommendations + zones (no login)
- `GET /api/compare?ids=1,2,3` → 2..6 projects side by side, each analyzed on demand
- `POST /api/advisory` {project_id, question} → grounded answer from stored contributions

Model inputs (12): rainfall_mm, elevation_m, slope_deg, dist_water_m, drainage_density, soil_infiltration_mmhr, impervious_pct, footprint_sqm, hist_flood_count, plinth_m, land_use_change_pct, catchment_sqm.

## ML service
- `POST /predict` {12 features, all required, range-checked} → {risk_score, risk_level, top_factors[3], contributions, model_version}
- `POST /flowpath` {elevation_grid?, seed?, size, cell_m, building?, allow_synthetic?, burn_lines?[{pts[[x,y]...],depth_m?}], burn_depth_m?} → {grid[][], flow_path[{x,y,h}], intersects, outlet, source, synthetic, burned_cells?}. Burned drains carve the DEM so flow snaps to registry drains; source becomes `surveyed-dem+burned-drains`.
- `POST /hydraulics` {segments[{id,dia_mm?,width_m?,kind?,status?,blocked_pct?}], rainfall_mm, catchment_sqm, impervious_pct, slope_deg?, duration_hr?} → {q_runoff_m3s, q_capacity_m3s, margin_ratio, surcharged_ids[], surcharged_count, segments, method}. Manning + rational planning proxy; margin<-0.2 lifts risk +6 in /simulate and backend /analyze. `status` containing `silt`/`bad` derates capacity (GCC STATUS=Bad → backend sends blocked_pct=40).
- `POST /design-drains` {roof_sqm, paved_sqm, design_rain_mmh?=100, slope_frac?=0.005} → {q_m3s, dia_mm, runs, capacity_m3s, velocity_ms, self_cleansing, note, method}. Sizes the site's internal RCC run (smallest standard barrel + 15% freeboard; 2 parallel runs above 600mm).
- `POST /simulate` {features + interventions + climate_uplift_pct} → {risk_score, resilience_score, badge, resilience_breakdown, contributions, heightmap, model_version}
- `POST /resilience` {12 features + design + intersects_building} → {resilience_score, badge, resilience_breakdown{6 params}}
- `POST /recommend` {features} → interventions[] (6 rule chains incl. land-use)
- `GET /health` → {model_loaded, model_version, features}
- `GET /version` → {service, model_version, model_loaded, training_meta}

## Shared Heightmap payload (2D + 3D use same)
```json
{
  "size": 64, "cell_m": 5.0,
  "grid": [[12.1, 12.0]],
  "flow_path": [{"x": 0.1, "y": 0.2, "h": 11.9}],
  "intersects": false,
  "outlet": {"x": 0.9, "y": 0.9},
  "source": "surveyed-dem | analytical-synthetic-v1",
  "synthetic": false
}
```
