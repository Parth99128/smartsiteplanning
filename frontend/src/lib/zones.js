/* Zone geometry helpers: planar area (equirectangular, fine for ≤1km sites),
   totals by kind, and mapping of drawn areas onto simulator inputs. */

function toXY(p, lat0) {
  const la = Array.isArray(p) ? p[0] : p.lat
  const ln = Array.isArray(p) ? p[1] : p.lng
  return [(ln) * 111320 * Math.cos((lat0 * Math.PI) / 180), la * 111320]
}

export function polygonAreaM2(polygon) {
  const pts = (polygon || [])
    .map((p) => (Array.isArray(p) ? { lat: p[0], lng: p[1] } : p))
    .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng))
  if (pts.length < 3) return 0
  const lat0 = pts.reduce((a, p) => a + p.lat, 0) / pts.length
  const xy = pts.map((p) => toXY(p, lat0))
  let a = 0
  for (let i = 0; i < xy.length; i++) {
    const [x1, y1] = xy[i], [x2, y2] = xy[(i + 1) % xy.length]
    a += x1 * y2 - x2 * y1
  }
  return Math.abs(a / 2)
}

export function zoneAreas(zones) {
  const per = zones.map((z) => ({ ...z, area_m2: Math.round(polygonAreaM2(z.polygon)) }))
  const byKind = {}
  for (const z of per) {
    byKind[z.kind] = (byKind[z.kind] || 0) + z.area_m2
  }
  const total = per.reduce((a, z) => a + z.area_m2, 0)
  return { per, byKind, total }
}

/* Buildable envelope from DCR setbacks (meters): front = south edge (road
   side), rear = north, sides = east/west. Returns {sw, ne} lat/lng. */
export function envelopeBounds(lat, lng, sb = {}) {
  const front = Math.max(0, Number(sb.front) || 0)
  const rear = Math.max(0, Number(sb.rear) || 0)
  const side = Math.max(0, Number(sb.side) || 0)
  const cos = Math.cos((Number(lat) * Math.PI) / 180) || 1
  const dLat = (m) => m / 111320
  const dLng = (m) => m / (111320 * cos)
  return {
    sw: [lat - 0.005 + dLat(front), lng - 0.005 + dLng(side)],
    ne: [lat + 0.005 - dLat(rear), lng + 0.005 - dLng(side)],
  }
}

function normPt(p) {
  return Array.isArray(p) ? { lat: p[0], lng: p[1] } : p
}

/* Building zones stepping outside the envelope (any vertex out). */
export function envelopeBreaches(zones, env) {
  const out = []
  for (const z of zones || []) {
    if (z.kind !== 'building') continue
    const pts = (z.polygon || []).map(normPt).filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng))
    const outside = pts.filter((p) =>
      p.lat < env.sw[0] || p.lat > env.ne[0] || p.lng < env.sw[1] || p.lng > env.ne[1]).length
    if (outside > 0) out.push({ id: z.id, name: z.name, outside, total: pts.length })
  }
  return out
}

/* Parking bay check: 1 ECS per 12.5 m² of drawn parking. */
export function parkingCheck(parkingM2, footprintM2, per100 = 1) {
  const provided = Math.floor((Number(parkingM2) || 0) / 12.5)
  const required = Math.ceil(((Number(footprintM2) || 0) / 100) * (Number(per100) || 0))
  return { provided, required, pass: provided >= required }
}

/* Drawn-area → simulator mapping. Returns patch suggestions with provenance. */
export function syncSuggestions(byKind) {
  const out = []
  if (byKind.building > 0) {
    out.push({ key: 'footprint_sqm', value: byKind.building, label: `Footprint ← building zones (${byKind.building} m²)` })
  }
  if (byKind.green > 0) {
    out.push({ key: 'green_sqm', value: byKind.green, label: `Green area ← green zones (${byKind.green} m²)` })
  }
  const perm = (byKind.open_space || 0) + (byKind.green || 0)
  if (perm > 0) {
    out.push({ key: 'permeable_sqm', value: perm, label: `Permeable ← open + green (${perm} m²)` })
  }
  return out
}
