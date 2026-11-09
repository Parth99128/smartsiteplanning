/* Real elevation grids from OpenTopoData (SRTM 90m — keyless, CORS-open).
   Turns the map pin into measured terrain: the backend traces the flow path
   over THIS grid instead of analytical noise.
   Polite + cached: ≤100 locations/request, small stagger, localStorage cache. */

const API = 'https://api.opentopodata.org/v1/srtm90m'
const EXTENT = 0.005 // ±0.005° ≈ ±550m site frame (matches the flow transform)

const key = (lat, lng, size) => `srtm-grid-v1-${Number(lat).toFixed(3)},${Number(lng).toFixed(3)}-${size}`

function readCache(k) {
  try {
    const j = JSON.parse(localStorage.getItem(k))
    if (j && Array.isArray(j.grid) && j.grid.length >= 8) return j
    return null
  } catch { return null }
}

function writeCache(k, v) {
  try { localStorage.setItem(k, JSON.stringify(v)) } catch { /* quota */ }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Fetch a size×size elevation grid (meters) over the site frame. Throws on failure. */
export async function fetchElevGrid(siteLat, siteLng, size = 20, signal) {
  const lat = Number(siteLat), lng = Number(siteLng)
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new Error('bad pin')
  const k = key(lat, lng, size)
  const hit = readCache(k)
  if (hit) return { ...hit, cached: true }

  // row-major lat/lng lists, north → south to match grid[row][col]
  const locs = []
  for (let r = 0; r < size; r++) {
    const la = lat + EXTENT - (r / (size - 1)) * 2 * EXTENT
    for (let c = 0; c < size; c++) {
      const ln = lng - EXTENT + (c / (size - 1)) * 2 * EXTENT
      locs.push(`${la.toFixed(6)},${ln.toFixed(6)}`)
    }
  }
  const elev = new Array(size * size).fill(null)
  for (let i = 0; i < locs.length; i += 100) {
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError')
    const chunk = locs.slice(i, i + 100)
    const r = await fetch(`${API}?locations=${chunk.join('|')}`, { signal })
    if (!r.ok) throw new Error(`elevation ${r.status}`)
    const j = await r.json()
    const res = j.results || []
    if (res.length !== chunk.length) throw new Error('elevation shape mismatch')
    res.forEach((p, n) => { elev[i + n] = typeof p.elevation === 'number' ? +p.elevation.toFixed(2) : null })
    if (i + 100 < locs.length) await sleep(250) // stay polite on the free tier
  }
  const valid = elev.filter((v) => v != null)
  if (valid.length < elev.length * 0.75) throw new Error('elevation voids')
  const mean = valid.reduce((a, b) => a + b, 0) / valid.length
  const grid = []
  for (let r = 0; r < size; r++) {
    const row = []
    for (let c = 0; c < size; c++) {
      const v = elev[r * size + c]
      row.push(v == null ? +mean.toFixed(2) : v)
    }
    grid.push(row)
  }
  const cellM = +(((2 * EXTENT * 111320) / size).toFixed(1))
  const out = { grid, size, cellM, source: 'srtm90m-opentopodata', cached: false }
  writeCache(k, out)
  return out
}
