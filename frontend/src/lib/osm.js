/* Real site context from OpenStreetMap (Overpass API — keyless, CORS-open).
   Turns the map pin into actual area design: building footprints + roads,
   normalized to the same 0..1 site frame the flow engine uses.
   Offline/rate-limit safe: localStorage cache + graceful fallback. */

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
]
const CACHE_PREFIX = 'osm-site-v2-'
const MAX_BUILDINGS = 80
const MAX_ROADS = 60
const MAX_WATER = 30
const MAX_PARKS = 30

const cacheKey = (lat, lng) => `${CACHE_PREFIX}${Number(lat).toFixed(3)},${Number(lng).toFixed(3)}`

function readCache(lat, lng) {
  try {
    const raw = localStorage.getItem(cacheKey(lat, lng))
    if (!raw) return null
    const j = JSON.parse(raw)
    if (!j || !Array.isArray(j.buildings)) return null
    return j
  } catch { return null }
}

function writeCache(lat, lng, data) {
  try { localStorage.setItem(cacheKey(lat, lng), JSON.stringify(data)) } catch { /* quota */ }
}

function parseHeight(tags = {}) {
  const h = String(tags.height || '').trim()
  const m = h.match(/^([\d.]+)/)
  if (m) {
    const v = Number(m[1])
    if (Number.isFinite(v) && v > 1 && v < 300) return v
  }
  const lv = Number(tags['building:levels'])
  if (Number.isFinite(lv) && lv > 0 && lv < 100) return lv * 3
  return null
}

function ringAreaM2(ring, lat) {
  let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9
  for (const [la, ln] of ring) {
    if (la < y0) y0 = la
    if (la > y1) y1 = la
    if (ln < x0) x0 = ln
    if (ln > x1) x1 = ln
  }
  const mx = (x1 - x0) * 111320 * Math.cos((lat * Math.PI) / 180)
  const my = (y1 - y0) * 111320
  return Math.abs(mx * my)
}

function pointInPoly(nx, ny, poly) {
  let c = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j]
    if (yi > ny !== yj > ny && nx < ((xj - xi) * (ny - yi)) / (yj - yi) + xi) c = !c
  }
  return c
}

/** Does a normalized footprint intersect any normalized flow point? */
export function footprintIntersects(poly, flowPath) {
  if (!poly?.length || !flowPath?.length) return false
  return flowPath.some((p) => pointInPoly(p.x, p.y, poly))
}

export async function fetchSiteContext(siteLat, siteLng, signal) {
  const lat = Number(siteLat), lng = Number(siteLng)
  const cached = readCache(lat, lng)
  const s = lat - 0.005, w = lng - 0.005, n = lat + 0.005, e = lng + 0.005
  const q = `[out:json][timeout:20];(way["building"](${s},${w},${n},${e});relation["building"]["type"="multipolygon"](${s},${w},${n},${e});way["highway"](${s},${w},${n},${e});way["natural"="water"](${s},${w},${n},${e});relation["natural"="water"]["type"="multipolygon"](${s},${w},${n},${e});way["leisure"~"^(park|garden|pitch|playground)$"](${s},${w},${n},${e}););out geom;`
  let elements = null
  let lastErr = null
  for (const url of ENDPOINTS) {
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
        body: 'data=' + encodeURIComponent(q),
        signal,
      })
      if (!r.ok) { lastErr = new Error(`overpass ${r.status}`); continue }
      const j = await r.json()
      elements = j.elements || []
      break
    } catch (err) {
      if (err?.name === 'AbortError') throw err
      lastErr = err
    }
  }
  if (!elements) {
    if (cached) return { ...cached, cached: true }
    throw lastErr || new Error('area map unreachable')
  }

  const toNorm = (la, ln) => [(ln - w) / 0.01, (la - s) / 0.01]
  const inFrame = ([nx, ny]) => nx > -0.05 && nx < 1.05 && ny > -0.05 && ny < 1.05
  const buildings = []
  const roads = []
  const water = []
  const parks = []

  for (const el of elements) {
    if (el.type === 'way' && el.tags?.building && Array.isArray(el.geometry)) {
      const ring = el.geometry.map((g) => toNorm(g.lat, g.lon)).filter(inFrame)
      if (ring.length < 4) continue
      const area = ringAreaM2(el.geometry.map((g) => [g.lat, g.lon]), lat)
      if (area < 25) continue
      buildings.push({
        poly: ring.map(([nx, ny]) => [+nx.toFixed(4), +ny.toFixed(4)]),
        areaM2: Math.round(area),
        heightM: parseHeight(el.tags) || (area > 500 ? 12 : area > 150 ? 9 : 6),
      })
    } else if (el.type === 'relation' && Array.isArray(el.members)) {
      for (const mem of el.members) {
        if (mem.role !== 'outer' || !Array.isArray(mem.geometry)) continue
        const ring = mem.geometry.map((g) => toNorm(g.lat, g.lon)).filter(inFrame)
        if (ring.length < 4) continue
        const area = ringAreaM2(mem.geometry.map((g) => [g.lat, g.lon]), lat)
        if (area < 25) continue
        buildings.push({
          poly: ring.map(([nx, ny]) => [+nx.toFixed(4), +ny.toFixed(4)]),
          areaM2: Math.round(area),
          heightM: parseHeight(el.tags) || (area > 500 ? 12 : area > 150 ? 9 : 6),
        })
        break // first outer ring is enough
      }
    } else if (el.type === 'way' && el.tags?.highway && Array.isArray(el.geometry)) {
      const line = el.geometry.map((g) => toNorm(g.lat, g.lon)).filter(inFrame)
      if (line.length >= 2) roads.push(line.map(([nx, ny]) => [+nx.toFixed(4), +ny.toFixed(4)]))
    } else if (el.type === 'way' && el.tags?.natural === 'water' && Array.isArray(el.geometry)) {
      const ring = el.geometry.map((g) => toNorm(g.lat, g.lon)).filter(inFrame)
      if (ring.length >= 4) water.push(ring.map(([nx, ny]) => [+nx.toFixed(4), +ny.toFixed(4)]))
    } else if (el.type === 'way' && el.tags?.leisure && Array.isArray(el.geometry)) {
      const ring = el.geometry.map((g) => toNorm(g.lat, g.lon)).filter(inFrame)
      if (ring.length >= 4) parks.push(ring.map(([nx, ny]) => [+nx.toFixed(4), +ny.toFixed(4)]))
    } else if (el.type === 'relation' && Array.isArray(el.members)) {
      // multipolygon water bodies: first outer ring is enough
      const tags = el.tags || {}
      if (tags.natural !== 'water') continue
      for (const mem of el.members) {
        if (mem.role !== 'outer' || !Array.isArray(mem.geometry)) continue
        const ring = mem.geometry.map((g) => toNorm(g.lat, g.lon)).filter(inFrame)
        if (ring.length >= 4) water.push(ring.map(([nx, ny]) => [+nx.toFixed(4), +ny.toFixed(4)]))
        break
      }
    }
  }

  buildings.sort((a, b) => b.areaM2 - a.areaM2)
  const data = {
    buildings: buildings.slice(0, MAX_BUILDINGS),
    roads: roads.slice(0, MAX_ROADS),
    water: water.slice(0, MAX_WATER),
    parks: parks.slice(0, MAX_PARKS),
    truncated: buildings.length > MAX_BUILDINGS,
    cached: false,
  }
  writeCache(lat, lng, data)
  return data
}
