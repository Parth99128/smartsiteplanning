#!/usr/bin/env python3
"""FloodShield GIS importer — pilot cities (stdlib only, no pip install).

Reads raw KML / KMZ / GeoJSON drops in database/gis_raw/{city}/ and emits:
  database/gis_processed/{city}.sql  (idempotent INSERTs into drain_lines/drain_points)
  database/gis_processed/{city}.json  (canonical audit log)
  database/gis_processed/all.sql      (concatenation)

City adapters:
  chennai   — every line -> kind=storm; width parsed from name/desc when present.
  bengaluru — ExtendedData type=primary|secondary|tertiary -> width/dia lookup (documented
              planning proxy, KSRSAC-2022). BWSSB sewer files -> kind=sewer.
  pune      — filename decides storm/nalla/river; *Chamber* files -> drain_points.

Rules: drop LineStrings <3m or <2 pts (degenerate only — municipal files chain
  short links between chambers, median ~12m in Pune); de-dupe by (city, rounded-wkt);
  ids stable: {city}:{slug}-{sha1(wkt)[:8]} so re-imports overwrite, never duplicate.
  INSERTs are batched 500 rows/statement for fast psql apply.

Usage:
  python tools/import-gis/import.py --city all --raw database/gis_raw --out database/gis_processed
  python tools/import-gis/import.py --city pune --raw database/gis_raw --out database/gis_processed --selftest
"""
import argparse
import hashlib
import json
import math
import os
import re
import sys
import xml.etree.ElementTree as ET
import zipfile

BENGALURU_TYPE = {
    "primary":   {"width_m": 3.5, "dia_mm": 1500},
    "secondary": {"width_m": 1.8, "dia_mm": 900},
    "tertiary":  {"width_m": 0.9, "dia_mm": 600},
}

CITY_SOURCES = {
    "chennai": "GCC-2023-via-OpenCity",
    "bengaluru": "KSRSAC-2022-via-OpenCity",
    "pune": "PMC-via-OpenCity",
    "nashik": "OSM-waterway-2026",
}

KML_NS = "{http://www.opengis.net/kml/2.2}"


def hav_m(a, b):
    R = 6371000.0
    la1, lo1, la2, lo2 = map(math.radians, [a[1], a[0], b[1], b[0]])
    h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    return 2 * R * math.asin(math.sqrt(h))


def line_len_m(coords):
    return sum(hav_m(coords[i], coords[i + 1]) for i in range(len(coords) - 1))


def slug(s):
    s = re.sub(r"[^a-z0-9]+", "-", (s or "").lower()).strip("-")
    return s[:32] or "seg"


def parse_kml_coords(text):
    pts = []
    for tok in (text or "").strip().split():
        parts = tok.split(",")
        if len(parts) >= 2:
            try:
                pts.append((float(parts[0]), float(parts[1])))
            except ValueError:
                continue
    return pts


def iter_kml_features(kml_path):
    """Yield dicts {name, desc, type_label, lines:[[lng,lat]...], points:[[lng,lat]...]}."""
    try:
        tree = ET.parse(kml_path)
    except ET.ParseError as e:
        print(f"[warn] skip unparseable {kml_path}: {e}", file=sys.stderr)
        return
    root = tree.getroot()
    for pm in root.iter(KML_NS + "Placemark"):
        name = (pm.findtext(KML_NS + "name") or "").strip()
        desc = (pm.findtext(KML_NS + "description") or "").strip()
        attrs = {}
        # ExtendedData <Data name="type"><value>tertiary</value> (KML spec style)
        for d in pm.findall(f"{KML_NS}ExtendedData/{KML_NS}Data"):
            v = d.findtext(KML_NS + "value")
            if d.get("name"):
                attrs[d.get("name")] = (v or "").strip()
        # ExtendedData <SchemaData><SimpleData name="Type">Primary</SimpleData> (GIS export style)
        for s in pm.findall(f"{KML_NS}ExtendedData/{KML_NS}SchemaData/{KML_NS}SimpleData"):
            if s.get("name"):
                attrs[s.get("name")] = (s.text or "").strip()
        type_label = ""
        for key in ("type", "Type", "class", "category", "DRAIN_TYPE", "drainaige_"):
            if attrs.get(key):
                type_label = attrs[key].strip().lower()
                break
        lines, points = [], []
        for ls in pm.findall(f".//{KML_NS}LineString"):
            c = parse_kml_coords(ls.findtext(f"{KML_NS}coordinates"))
            if len(c) >= 2:
                lines.append(c)
        for pt in pm.findall(f".//{KML_NS}Point"):
            c = parse_kml_coords(pt.findtext(f"{KML_NS}coordinates"))
            if c:
                points.append(c[0])
        if lines or points:
            yield {"name": name, "desc": desc, "type_label": type_label, "attrs": attrs,
                   "lines": lines, "points": points}


def read_features(path):
    low = path.lower()
    if low.endswith(".kmz"):
        out = []
        with zipfile.ZipFile(path) as z:
            names = [n for n in z.namelist() if n.lower().endswith(".kml")]
            if not names:
                print(f"[warn] kmz without kml: {path}", file=sys.stderr)
                return out
            for n in names:
                tmp = path + "." + n.replace("/", "_") + ".tmp.kml"
                with z.open(n) as src, open(tmp, "wb") as dst:
                    dst.write(src.read())
                out.extend(list(iter_kml_features(tmp)))
                os.remove(tmp)
        return out
    if low.endswith(".kml"):
        return list(iter_kml_features(path))
    if low.endswith(".geojson") or low.endswith(".json"):
        with open(path, encoding="utf-8") as fh:
            gj = json.load(fh)
        feats = gj.get("features", gj if isinstance(gj, list) else [])
        out = []
        for f in feats:
            g = (f.get("geometry") or {}) if isinstance(f, dict) else {}
            p = (f.get("properties") or {}) if isinstance(f, dict) else {}
            t = g.get("type")
            if t == "LineString":
                out.append({"name": str(p.get("name", "")), "desc": "",
                            "type_label": str(p.get("type", p.get("class", ""))).lower(),
                            "kind_hint": str(p.get("kind", "")).lower(),
                            "lines": [g["coordinates"]], "points": []})
            elif t == "MultiLineString":
                out.append({"name": str(p.get("name", "")), "desc": "",
                            "type_label": str(p.get("type", p.get("class", ""))).lower(),
                            "kind_hint": str(p.get("kind", "")).lower(),
                            "lines": g["coordinates"], "points": []})
            elif t == "Point":
                out.append({"name": str(p.get("name", "")), "desc": "",
                            "type_label": "", "lines": [], "points": [tuple(g["coordinates"][:2])]})
        return out
    print(f"[warn] unsupported file (need .kml/.kmz/.geojson): {path}", file=sys.stderr)
    return []


def _fnum(v):
    try:
        f = float(str(v).strip().split()[0])
        return f if math.isfinite(f) else None
    except (ValueError, AttributeError, IndexError):
        return None


def classify(city, filename, feat):
    """Returns (kind, type_label, width_m, dia_mm, invert_m, status).

    Prefers MEASURED attributes from the municipal file (Chennai INVERT_SP/EP,
    DRAIN_WID/DEP; Pune pipeline_d/start_inve). Falls back to documented
    planning proxies (Bengaluru type->section). Never invents precision:
    unknown stays None.
    """
    fn = filename.lower()
    tl = (feat["type_label"] or "").lower()
    attrs = feat.get("attrs", {}) or {}
    if city == "bengaluru":
        if "sewer" in fn:
            return "sewer", tl or "sewer", None, None, None, "unknown"
        if "lake" in fn or "stream" in fn:
            return "lake_link", tl or "", None, None, None, "unknown"
        if tl in BENGALURU_TYPE:
            m = BENGALURU_TYPE[tl]
            return "storm", tl, m["width_m"], m["dia_mm"], None, "unknown"
        return "storm", tl or "unclassified", None, None, None, "unknown"
    if city == "nashik":
        # OSM-hydro GeoJSON arrives pre-classified (kind in properties).
        kind = feat.get("kind_hint") or "open_drain"
        if kind not in ("storm", "sewer", "open_drain", "nalla", "canal", "river", "lake_link"):
            kind = "open_drain"
        return kind, tl or feat["name"][:48] or "osm-hydro", None, None, None, "unknown"
    if city == "pune":
        if "chamber" in fn:
            return "chamber-file", "", None, None, None, "unknown"
        if "nalla" in fn:
            return "nalla", tl or "nalla", 1.5, None, None, "unknown"
        if "river" in fn:
            return "river", tl or "river", 12.0, None, None, "unknown"
        # PMC KMZ = buried RCC sewer collection network (measured dia + inverts)
        dia = _fnum(attrs.get("pipeline_d"))
        inv_s, inv_e = _fnum(attrs.get("start_inve")), _fnum(attrs.get("end_invert"))
        inv = None
        if inv_s is not None and inv_e is not None:
            inv = round((inv_s + inv_e) / 2, 2)
        elif inv_s is not None:
            inv = inv_s
        status = str(attrs.get("phase") or "unknown")[:24] or "unknown"
        tlabel = (attrs.get("drainaige_") or attrs.get("category") or "sewer").strip().lower()[:48]
        return "sewer", tlabel, None, int(dia) if dia else None, inv, status
    # chennai: measured width/depth/inverts/status per segment
    w = _fnum(attrs.get("DRAIN_WID"))
    if w is not None and not (0.1 <= w <= 30):
        w = None
    if w is None:
        m = re.search(r"(\d+(?:\.\d+)?)\s*m", (feat["name"] + " " + feat["desc"]).lower())
        if m:
            w = _fnum(m.group(1))
            if w is not None and not (0.1 <= w <= 30):
                w = None
    inv_s, inv_e = _fnum(attrs.get("INVERT_SP")), _fnum(attrs.get("INVERT_EP"))
    inv = None
    if inv_s is not None and inv_e is not None:
        inv = round((inv_s + inv_e) / 2, 2)
    elif inv_s is not None:
        inv = inv_s
    status = str(attrs.get("STATUS") or "unknown").strip()[:24] or "unknown"
    tlabel = (tl or attrs.get("DRAIN_TYPE") or feat["name"])[:48]
    return "storm", tlabel, w, None, inv, status


def sql_esc(s):
    return "'" + str(s).replace("'", "''") + "'"


def wkt_linestring(coords):
    return "LINESTRING(" + ",".join(f"{x:.6f} {y:.6f}" for x, y in coords) + ")"


def process_city(city, raw_dir, out_dir):
    files = sorted(f for f in os.listdir(raw_dir)
                   if f.lower().endswith((".kml", ".kmz", ".geojson", ".json"))
                   and not f.startswith("."))
    lines_out, points_out, seen, dropped = [], [], set(), 0
    for fn in files:
        path = os.path.join(raw_dir, fn)
        for feat in read_features(path):
            kind, type_label, width_m, dia_mm, invert_m, status = classify(city, fn, feat)
            # chamber files carry BOTH lines (drains) and points (inlets) — import both
            if kind == "chamber-file":
                for pt in feat["points"]:
                    key = (city, round(pt[0], 6), round(pt[1], 6))
                    if key in seen:
                        continue
                    seen.add(key)
                    pid = f"{city}:ch-{hashlib.sha1(f'{pt}'.encode()).hexdigest()[:8]}"
                    points_out.append({"id": pid, "lng": pt[0], "lat": pt[1],
                                       "kind": "chamber", "source": CITY_SOURCES[city]})
                if not feat["lines"]:
                    continue
                kind, type_label, width_m, dia_mm = "storm", feat["name"][:48] or "pune-chamber-drain", None, None
                invert_m, status = None, "unknown"
            is_point_file = "chamber" in fn.lower()
            if is_point_file:
                for pt in feat["points"]:
                    key = (city, round(pt[0], 6), round(pt[1], 6))
                    if key in seen:
                        continue
                    seen.add(key)
                    pid = f"{city}:ch-{hashlib.sha1(f'{pt}'.encode()).hexdigest()[:8]}"
                    points_out.append({"id": pid, "lng": pt[0], "lat": pt[1],
                                       "kind": "chamber", "source": CITY_SOURCES[city]})
            for coords in feat["lines"]:
                if len(coords) < 2:
                    dropped += 1
                    continue
                if line_len_m(coords) < 3:
                    dropped += 1
                    continue
                rwkt = ",".join(f"{round(x,5)},{round(y,5)}" for x, y in coords)
                key = (city, kind, hashlib.sha1(rwkt.encode()).hexdigest())
                if key in seen:
                    continue
                seen.add(key)
                did = f"{city}:{slug(type_label or kind)}-{hashlib.sha1(rwkt.encode()).hexdigest()[:8]}"
                if status == "unknown" and "proposed" in fn.lower():
                    status = "proposed"
                lines_out.append({"id": did, "kind": kind, "type_label": type_label[:48],
                                  "wkt": wkt_linestring(coords),
                                  "width_m": width_m, "dia_mm": dia_mm, "invert_m": invert_m,
                                  "status": status,
                                  "source": CITY_SOURCES[city]})
    # write SQL (batched multi-row INSERTs, 500 rows each)
    os.makedirs(out_dir, exist_ok=True)
    sql_path = os.path.join(out_dir, f"{city}.sql")
    with open(sql_path, "w", encoding="utf-8") as fh:
        fh.write(f"-- {city}: {len(lines_out)} lines, {len(points_out)} points (dropped stubs: {dropped})\n")
        for i in range(0, len(lines_out), 500):
            chunk = lines_out[i:i + 500]
            vals = []
            for r in chunk:
                vals.append(
                    f"({sql_esc(r['id'])},{sql_esc(city)},ST_GeogFromText({sql_esc('SRID=4326;' + r['wkt'])}),"
                    f"{sql_esc(r['kind'])},{sql_esc(r['type_label'])},"
                    f"{'NULL' if r['width_m'] is None else r['width_m']},"
                    f"{'NULL' if r['dia_mm'] is None else r['dia_mm']},"
                    f"{'NULL' if r.get('invert_m') is None else r['invert_m']},"
                    f"{sql_esc(r['status'])},{sql_esc(r['source'])})")
            fh.write(
                "INSERT INTO drain_lines(id,city,geom,kind,type_label,width_m,dia_mm,invert_m,status,source) VALUES\n"
                + ",\n".join(vals) +
                "\nON CONFLICT (id) DO UPDATE SET geom=EXCLUDED.geom,kind=EXCLUDED.kind,"
                "type_label=EXCLUDED.type_label,width_m=EXCLUDED.width_m,dia_mm=EXCLUDED.dia_mm,"
                "invert_m=EXCLUDED.invert_m,status=EXCLUDED.status,source=EXCLUDED.source,updated_at=now();\n")
        for i in range(0, len(points_out), 500):
            chunk = points_out[i:i + 500]
            vals = []
            for p in chunk:
                wkt_pt = "SRID=4326;POINT(%.6f %.6f)" % (p['lng'], p['lat'])
                vals.append(
                    f"({sql_esc(p['id'])},{sql_esc(city)},"
                    f"ST_GeogFromText({sql_esc(wkt_pt)}),"
                    f"{sql_esc(p['kind'])},{sql_esc(p['source'])})")
            fh.write(
                "INSERT INTO drain_points(id,city,geom,kind,source) VALUES\n"
                + ",\n".join(vals) +
                "\nON CONFLICT (id) DO UPDATE SET geom=EXCLUDED.geom,source=EXCLUDED.source;\n")
        fh.write(
            f"UPDATE cities SET drain_count=(SELECT COUNT(*) FROM drain_lines WHERE city={sql_esc(city)}),"
            f"inlet_count=(SELECT COUNT(*) FROM drain_points WHERE city={sql_esc(city)}),"
            f"updated_at=now() WHERE code={sql_esc(city)};\n")
        file_hash = hashlib.sha1(f"{len(lines_out)}-{len(points_out)}-{city}".encode()).hexdigest()[:12]
        fh.write(
            "INSERT INTO gis_imports(city,file_hash,features,inlets) VALUES "
            f"({sql_esc(city)},{sql_esc(file_hash)},{len(lines_out)},{len(points_out)}) "
            "ON CONFLICT (city) DO UPDATE SET file_hash=EXCLUDED.file_hash,"
            "features=EXCLUDED.features,inlets=EXCLUDED.inlets,imported_at=now();\n")
    audit = {"city": city, "files": files, "lines": len(lines_out),
             "points": len(points_out), "dropped_stubs": dropped,
             "source": CITY_SOURCES[city]}
    with open(os.path.join(out_dir, f"{city}.json"), "w", encoding="utf-8") as fh:
        json.dump(audit, fh, indent=2)
    print(f"[{city}] {len(lines_out)} lines, {len(points_out)} points from {len(files)} files "
          f"(dropped {dropped}) -> {sql_path}")
    return audit


SELFTEST_KML = """<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document>
<Placemark><name>tertiary drain T1</name><ExtendedData><Data name="type"><value>tertiary</value></Data></ExtendedData>
<LineString><coordinates>77.6900,12.9700 77.6950,12.9720 77.7000,12.9740</coordinates></LineString></Placemark>
<Placemark><name>Chamber C1</name><Point><coordinates>77.6960,12.9725</coordinates></Point></Placemark>
</Document></kml>"""


def selftest(raw_dir):
    d = os.path.join(raw_dir, "pune")
    os.makedirs(d, exist_ok=True)
    p = os.path.join(d, "SELFTEST-SWD-Chambers.kml")
    if not os.path.exists(p):
        with open(p, "w", encoding="utf-8") as fh:
            fh.write(SELFTEST_KML)
        print(f"[selftest] wrote {p}")
    else:
        print(f"[selftest] fixture exists: {p}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--city", default="all", help="chennai|bengaluru|pune|all")
    ap.add_argument("--raw", default="database/gis_raw")
    ap.add_argument("--out", default="database/gis_processed")
    ap.add_argument("--selftest", action="store_true", help="write tiny offline fixture and import it")
    a = ap.parse_args()
    cities = ["chennai", "bengaluru", "pune", "nashik"] if a.city == "all" else [a.city]
    if a.selftest:
        selftest(a.raw)
    os.makedirs(a.out, exist_ok=True)
    audits = []
    for c in cities:
        rd = os.path.join(a.raw, c)
        if not os.path.isdir(rd):
            print(f"[{c}] no raw dir {rd} — skipping (drop KMLs per database/gis_raw/README.md)")
            continue
        audits.append(process_city(c, rd, a.out))
    with open(os.path.join(a.out, "all.sql"), "w", encoding="utf-8") as fh:
        for c in cities:
            p = os.path.join(a.out, f"{c}.sql")
            if os.path.exists(p):
                fh.write(open(p, encoding="utf-8").read() + "\n")
    print(f"done: {[(x['city'], x['lines'], x['points']) for x in audits]}")


if __name__ == "__main__":
    main()
