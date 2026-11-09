#!/usr/bin/env python3
"""Backfill NULL invert_m from SRTM90 ground elevation (stdlib only).

Scope: a single ward circle at a time (polite to the free OpenTopoData tier:
100 locations/request). Full-city backfill would exceed the 1000-calls/day
free quota, so officers run this ward-by-ward as they verify areas.

  invert = ground_elev - cover, cover = min(1.2, 0.5*width_m) for open drains,
  1.5m for sewers. Source is labelled 'srtm90m-estimate' — an estimate,
  never presented as survey. Measured inverts (Chennai, Pune sewers) win:
  only NULL rows are touched.

Usage:
  # 1. export midpoints (run from repo root, needs live PostGIS):
  docker exec climate-db-1 psql -U floodshield -d floodshield -c \
    "COPY (SELECT id, ST_Y(ST_Centroid(geom::geometry)), ST_X(ST_Centroid(geom::geometry)), width_m, kind \
     FROM drain_lines WHERE city='bengaluru' AND invert_m IS NULL \
     AND ST_DWithin(geom, ST_GeogFromText('SRID=4326;POINT(77.6770 12.9250)'), 500)) \
     TO STDOUT WITH CSV" > /tmp/mids.csv
  # 2. build the UPDATE script:
  python tools/import-gis/backfill_invert.py --in /tmp/mids.csv --out database/gis_processed/invert-bengaluru-bellandur.sql
  # 3. apply:
  Get-Content <out> -Raw | docker exec -i climate-db-1 psql -U floodshield -d floodshield -v ON_ERROR_STOP=1
"""
import argparse
import csv
import json
import time
import urllib.parse
import urllib.request

API = "https://api.opentopodata.org/v1/srtm90m"


def fetch_elev(locs):
    """locs: [(lat, lng)] max 100. Returns [elev|None]."""
    q = "|".join(f"{la:.6f},{ln:.6f}" for la, ln in locs)
    url = API + "?locations=" + urllib.parse.quote(q, safe="|,.")
    req = urllib.request.Request(url, headers={"User-Agent": "FloodShieldAI/1.0 (ward backfill)"})
    with urllib.request.urlopen(req, timeout=60) as r:
        j = json.load(r)
    out = []
    for res in j.get("results", []):
        e = res.get("elevation")
        out.append(round(float(e), 2) if isinstance(e, (int, float)) else None)
    if len(out) != len(locs):
        raise RuntimeError(f"elevation shape mismatch: {len(out)} vs {len(locs)}")
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="inp", required=True, help="CSV: id,lat,lng,width_m,kind (no header)")
    ap.add_argument("--out", required=True)
    ap.add_argument("--max", type=int, default=2000, help="safety cap on rows")
    a = ap.parse_args()

    import io

    rows = []
    raw = open(a.inp, "rb").read()
    # PowerShell `>` redirection writes UTF-16; plain pipes write UTF-8.
    text = raw.decode("utf-16") if raw.startswith(b"\xff\xfe") else raw.decode("utf-8-sig")
    for rec in csv.reader(io.StringIO(text)):
            if len(rec) < 5:
                continue
            _id, la, ln, w, kind = rec[0], float(rec[1]), float(rec[2]), rec[3], rec[4]
            try:
                w = float(w) if w else None
            except ValueError:
                w = None
            rows.append((_id, la, ln, w, kind))
    rows = rows[: a.max]
    if not rows:
        print("no rows to backfill")
        return

    stmts = []
    filled = 0
    for i in range(0, len(rows), 100):
        chunk = rows[i : i + 100]
        elevs = fetch_elev([(la, ln) for _, la, ln, _, _ in chunk])
        for (_id, la, ln, w, kind), e in zip(chunk, elevs):
            if e is None:
                continue
            cover = 1.5 if kind == "sewer" else min(1.2, 0.5 * (w or 0.9))
            inv = round(e - cover, 2)
            safe = _id.replace("'", "''")
            stmts.append(
                f"UPDATE drain_lines SET invert_m={inv}, "
                f"source=source||' +srtm90m-invert', updated_at=now() "
                f"WHERE id='{safe}' AND invert_m IS NULL;"
            )
            filled += 1
        if i + 100 < len(rows):
            time.sleep(1)  # stay polite on the free tier
    with open(a.out, "w", encoding="utf-8") as fh:
        fh.write(f"-- invert backfill: {filled}/{len(rows)} filled (srtm90m-estimate)\n")
        fh.write("\n".join(stmts) + "\n")
    print(f"filled {filled}/{len(rows)} -> {a.out}")


if __name__ == "__main__":
    main()
