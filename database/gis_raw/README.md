# GIS raw drops (pilot cities — Public Domain via OpenCity.in)

Drop downloaded files here, then run the importer. Raw files are never edited.

## Chennai (`chennai/`)
- `Chennai-SWD-2023.kml` ← data.opencity.in/dataset/chennai-stormwater-drain-swd-maps (city KML)
- optional: `reclaim-chennai-derived.geojson` ← github.com/reclaimchennai/chennai-swd `derived/` (connected network, preferred when present)
- optional validation: `Chennai-2015-Inundation.kml` (NRSC, for hindcast only, not imported)

## Bengaluru (`bengaluru/`)
- `Bengaluru-SWD-2022.kml` (26 MB, KSRSAC, has `type=primary|secondary|tertiary`)
- optional: `BWSSB-Sewer-*.kml`, `BWSSB-WaterSupply-*.kml`, `ATREE-Lakes-Streams.kml`

## Pune (`pune/`)
- `PMC-SWD.kmz` + `Pune-Nalla.kml` + `Pune-River.kml`
- `PMC-SWD-Chambers.kml` (point inlets — imported to drain_points)

## Nashik (`nashik/`) — OSM-hydro tier
No open municipal registry exists. Drain geometry comes from OSM waterways:
```powershell
python tools/import-gis/osm_hydro.py --city nashik --south 19.90 --west 73.65 --north 20.10 --east 73.95 --out database/gis_raw/nashik/Nashik-OSM-Hydro.geojson --tiles 2
```
142 ways (Godavari rivers, canals, streams, drains, ditches), source `OSM-waterway-2026`, no diameters/inverts. Register with `database/migrations/007_nashik_city.sql`. Same workflow extends to any new city.

## Import
```powershell
python tools/import-gis/import.py --city all --raw database/gis_raw --out database/gis_processed
psql $env:DATABASE_URL -f database/migrations/003_city_drains.sql  # first time only
psql $env:DATABASE_URL -f database/gis_processed/chennai.sql
psql $env:DATABASE_URL -f database/gis_processed/bengaluru.sql
psql $env:DATABASE_URL -f database/gis_processed/pune.sql
```
Importer is stdlib-only (no pip install). Idempotent: batched `ON CONFLICT(id) DO UPDATE`.
Short links (<3m) are dropped as degenerate; municipal files chain short links
between chambers (Pune median ~12m), so the threshold stays low on purpose.

## Measured-invert coverage (no estimation where the ULB already surveyed)
- Chennai: 10,214/10,270 inverts + widths + STATUS per segment (INVERT_SP/EP, DRAIN_WID)
- Pune KMZ: 115,967/128,327 sewer dia (pipeline_d) + inverts (start_inve/end_invert)
- Bengaluru: widths/dia via Primary/Secondary/Tertiary proxy; inverts estimated
  ward-by-ward with `tools/import-gis/backfill_invert.py` (labelled `srtm90m-invert`).
  Full-city backfill exceeds the free OpenTopoData quota — run per ward as verified.
