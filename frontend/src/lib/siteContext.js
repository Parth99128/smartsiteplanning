/* Municipal drain context (pilot cities) — cached, offline-safe, never throws.
   Backend POST /api/sites/context returns registry drains + burn lines +
   hydraulics segments for the pin. Outside pilot cities it returns city:null.
   Callers treat null as "geo-estimate only". */
import { api } from '../api'

const mem = new Map()
const skey = (lat, lng) => `ctx-v1-${Number(lat).toFixed(3)},${Number(lng).toFixed(3)}`

function readCache(k) {
  if (mem.has(k)) return mem.get(k)
  try {
    const raw = sessionStorage.getItem(k)
    if (raw) {
      const j = JSON.parse(raw)
      if (j && 'confidence' in j) {
        mem.set(k, j)
        return j
      }
    }
  } catch { /* private mode */ }
  return null
}

function writeCache(k, v) {
  mem.set(k, v)
  try { sessionStorage.setItem(k, JSON.stringify(v)) } catch { /* quota */ }
}

export async function fetchSiteContext(lat, lng, signal) {
  const la = Number(lat), ln = Number(lng)
  if (!Number.isFinite(la) || !Number.isFinite(ln)) return null
  const k = skey(la, ln)
  const hit = readCache(k)
  if (hit) return { ...hit, cached: true }
  try {
    const r = await api.post('/sites/context', { lat: la, lng: ln, radius_m: 500 }, { signal, timeout: 12000 })
    const ctx = r.data || null
    if (ctx) writeCache(k, ctx)
    return ctx ? { ...ctx, cached: false } : null
  } catch {
    return hit ? { ...hit, cached: true } : null
  }
}

export async function fetchCities() {
  try {
    const r = await api.get('/cities', { timeout: 8000 })
    return Array.isArray(r.data) ? r.data : []
  } catch { return [] }
}

/* Normalized drain geom [[nx,ny]...] → Leaflet lat/lngs around the pin. */
export function drainToLatLngs(geom, lat, lng) {
  const la0 = Number(lat) - 0.005, ln0 = Number(lng) - 0.005
  return (geom || [])
    .map(([nx, ny]) => [la0 + Number(ny) * 0.01, ln0 + Number(nx) * 0.01])
    .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b))
}

export const DRAIN_COLOR = {
  storm: '#22d3ee', open_drain: '#22d3ee', nalla: '#a16207',
  canal: '#38bdf8', river: '#60a5fa', sewer: '#a78bfa', lake_link: '#34d399',
}
