#!/usr/bin/env python3
"""Fetch OSM waterway geometry into a canonical GeoJSON for the GIS importer.

Used for cities WITHOUT an open municipal drain registry (e.g. Nashik):
rivers, canals, drains, streams and ditches mapped by OSM volunteers become
`drain_lines` rows labelled source=OSM-waterway-*. Honest tier: no diameters,
no inverts — but real channel geometry for DEM burn, dist_drain_m and density.

Usage:
  python tools/import-gis/osm_hydro.py --city nashik \\
    --south 19.90 --west 73.65 --north 20.10 --east 73.95 \\
    --out database/gis_raw/nashik/Nashik-OSM-Hydro.geojson
Then run import.py as usual (it classifies city=nashik from properties.kind).
"""
import argparse
import json
import time
import urllib.parse
import urllib.request

ENDPOINTS = [
    "https://overpass.private.coffee/api/interpreter",
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]

# OSM waterway -> (drain_lines.kind, type_label). Streams/ditches are the
# natural monsoon channels Indian cities call nallas / open drains.
KINDMAP = {
    "river": ("river", "osm-river"),
    "canal": ("canal", "osm-canal"),
    "drain": ("storm", "osm-drain"),
    "stream": ("nalla", "osm-stream"),
    "ditch": ("open_drain", "osm-ditch"),
    "pressurised": ("sewer", "osm-pressurised"),
}


def fetch(bbox, timeout=120):
    s, w, n, e = bbox
    q = (f"[out:json][timeout:100];(way[\"waterway\"~\"^(river|canal|drain|stream|ditch|pressurised)$\"]"
         f"({s},{w},{n},{e}););out geom;")
    last = None
    for ep in ENDPOINTS:
        try:
            url = ep + "?data=" + urllib.parse.quote(q, safe="")
            req = urllib.request.Request(url, headers={"User-Agent": "FloodShieldAI/1.0 (hydro-import)"})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.load(r)
        except Exception as ex:  # noqa: BLE001 - try next mirror
            last = ex
            time.sleep(2)
    raise RuntimeError(f"all overpass mirrors failed: {last}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--city", required=True)
    ap.add_argument("--south", type=float, required=True)
    ap.add_argument("--west", type=float, required=True)
    ap.add_argument("--north", type=float, required=True)
    ap.add_argument("--east", type=float, required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--tiles", type=int, default=2,
                    help="split bbox into tiles×tiles queries (overpass timeouts)")
    a = ap.parse_args()

    # Tile the bbox: big metro queries time out on public mirrors.
    boxes = []
    for i in range(a.tiles):
        for j in range(a.tiles):
            boxes.append((
                a.south + (a.north - a.south) * i / a.tiles,
                a.west + (a.east - a.west) * j / a.tiles,
                a.south + (a.north - a.south) * (i + 1) / a.tiles,
                a.west + (a.east - a.west) * (j + 1) / a.tiles,
            ))
    feats, skipped, seen = [], 0, set()
    for n, box in enumerate(boxes):
        print(f"  tile {n + 1}/{len(boxes)} {tuple(round(v, 3) for v in box)}...")
        try:
            data = fetch(box)
        except Exception as ex:  # noqa: BLE001 - one bad tile must not kill the city
            print(f"  tile {n + 1} failed: {ex}")
            continue
        for el in data.get("elements", []):
            if el.get("type") != "way":
                skipped += 1
                continue
            if el.get("id") in seen:  # tile overlaps share border ways
                continue
            seen.add(el.get("id"))
            tags = el.get("tags", {})
            ww = (tags.get("waterway") or "").lower()
            if ww not in KINDMAP:
                skipped += 1
                continue
            geom = el.get("geometry", [])
            coords = [[g["lon"], g["lat"]] for g in geom
                      if isinstance(g.get("lon"), (int, float)) and isinstance(g.get("lat"), (int, float))]
            if len(coords) < 2:
                skipped += 1
                continue
            kind, tl = KINDMAP[ww]
            name = tags.get("name") or ""
            feats.append({"type": "Feature",
                          "properties": {"kind": kind, "type": tl, "name": name,
                                         "osm_id": el.get("id"), "waterway": ww},
                          "geometry": {"type": "LineString", "coordinates": coords}})
    gj = {"type": "FeatureCollection", "features": feats}
    with open(a.out, "w", encoding="utf-8") as fh:
        json.dump(gj, fh)
    print(f"[{a.city}] {len(feats)} ways -> {a.out} (skipped {skipped})")


if __name__ == "__main__":
    main()
