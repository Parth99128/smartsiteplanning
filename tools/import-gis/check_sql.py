"""Dev-only audit of generated {city}.sql: kind/type/invert coverage."""
import re
import sys

city = sys.argv[1] if len(sys.argv) > 1 else "chennai"
sql = open(f"database/gis_processed/{city}.sql", encoding="utf-8").read()

# Split batched VALUES rows: each row starts with "('id'," at line start
rows = re.findall(r"^\(\'.+?\n?(?=,\n|\nON CONFLICT)", sql, re.M)
print(city, "value-rows found:", len(rows))
if rows:
    print("SAMPLE:", rows[0][:300].replace("\n", " "))
kinds = {}
types = {}
invert_n = 0
dia_n = 0
width_n = 0
for r in rows:
    # fields: id, city, ST_GeogFromText('...'), kind, type_label, width, dia, invert, status, source
    # geom contains commas so split carefully on "','"
    parts = r.split("','")
    # parts[0]="('id"  parts[1]="city" parts[2]="ST_GeogFromText('SRID=4326;...multiline...',kind',..."
    tail = parts[-1] if len(parts) > 1 else r
    # last fields are: ...,width,dia,invert,status','source')
    m = re.search(r",([^,]+),([^,]+),([^,]+),\'([^\']*)\',\'([^\']*)\'\)$", tail.replace("\n", ""))
    if not m:
        continue
    w, d, inv, status, src = m.groups()
    # kind/type: find "',kind','type'," pattern after geom close "')"
    km = re.search(r"\)'\),\'([^\']*)\',\'([^\']*)\',", r.replace("\n", " "))
    kind = km.group(1) if km else "?"
    tl = km.group(2) if km else "?"
    kinds[kind] = kinds.get(kind, 0) + 1
    types[tl] = types.get(tl, 0) + 1
    if w != "NULL":
        width_n += 1
    if d != "NULL":
        dia_n += 1
    if inv != "NULL":
        invert_n += 1
print("kinds:", kinds)
top_types = sorted(types.items(), key=lambda x: -x[1])[:8]
print("top types:", top_types)
print(f"width:{width_n} dia:{dia_n} invert:{invert_n} / {len(rows)}")
