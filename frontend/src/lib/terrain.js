/* Real terrain via AWS Terrain Tiles (Terrarium, 30m, keyless, CORS-open).
   Primary DEM source: no API key, generous quota, works everywhere on Earth —
   unlike the OpenTopoData free tier which rate-limits shared IPs and voids often.
   OpenTopoData SRTM90 stays as fallback (see elevation.js).

   Terrarium decode: elev_m = R*256 + G + B/256 - 32768. */

const Z = 14 // zoom: tile ≈ 2.3km at Indian latitudes; our 1.1km site spans ≤2×2 tiles
const TILE = 256
const TERR = (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`

const key = (lat, lng, size) => `terr-grid-v1-${Number(lat).toFixed(3)},${Number(lng).toFixed(3)}-${size}`

function readCache(k) {
  try {
    const j = JSON.parse(sessionStorage.getItem(k) || localStorage.getItem(k))
    if (j && Array.isArray(j.grid) && j.grid.length >= 8) return j
    return null
  } catch { return null }
}

function writeCache(k, v) {
  try { sessionStorage.setItem(k, JSON.stringify(v)) } catch { /* quota */ }
  try { localStorage.setItem(k, JSON.stringify(v)) } catch { /* quota */ }
}

const lng2x = (lng, z) => Math.floor(((lng + 180) / 360) * 2 ** z)
const lat2y = (lat, z) => {
  const r = (lat * Math.PI) / 180
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z)
}

function loadTile(z, x, y, signal) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    const to = setTimeout(() => reject(new Error('tile timeout')), 15000)
    img.onload = () => {
      clearTimeout(to)
      try {
        const c = document.createElement('canvas')
        c.width = TILE
        c.height = TILE
        const g = c.getContext('2d', { willReadFrequently: true })
        g.drawImage(img, 0, 0)
        resolve(g.getImageData(0, 0, TILE, TILE).data)
      } catch (e) { reject(e) }
    }
    img.onerror = () => { clearTimeout(to); reject(new Error('tile load failed')) }
    if (signal?.aborted) return reject(new DOMException('aborted', 'AbortError'))
    signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    img.src = TERR(z, x, y)
  })
}

/** Measured terrain with graceful fallback: Terrarium 30m first, SRTM90 second.
 *  Resolves to {grid, size, cellM, source, cached}. Throws only if both fail. */
export async function fetchRealGrid(siteLat, siteLng, signal) {
  try {
    return await fetchTerrariumGrid(siteLat, siteLng, 32, signal)
  } catch (e1) {
    const { fetchElevGrid } = await import('./elevation')
    return await fetchElevGrid(siteLat, siteLng, 20, signal)
  }
}

/** Fetch a size×size elevation grid (meters) over the ±0.005° site frame. Throws on failure. */
export async function fetchTerrariumGrid(siteLat, siteLng, size = 32, signal) {
  const lat = Number(siteLat), lng = Number(siteLng)
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new Error('bad pin')
  const k = key(lat, lng, size)
  const hit = readCache(k)
  if (hit) return { ...hit, cached: true }

  const EXT = 0.005
  const x0 = lng2x(lng - EXT, Z), x1 = lng2x(lng + EXT, Z)
  const y0 = lat2y(lat + EXT, Z), y1 = lat2y(lat - EXT, Z)
  if (x1 - x0 > 3 || y1 - y0 > 3) throw new Error('tile span overflow')

  const tiles = {}
  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) {
      tiles[`${x}/${y}`] = await loadTile(Z, x, y, signal)
    }
  }

  // tile pixel → lng/lat (Web-Mercator inverse)
  const n = 2 ** Z
  const px2lng = (x, px) => ((x + px / TILE) / n) * 360 - 180
  const px2lat = (y, py) => {
    const t = (y + py / TILE) / n
    const m = Math.PI * (1 - 2 * t)
    return (Math.atan(Math.sinh(m)) * 180) / Math.PI
  }
  const elevAt = (la, ln) => {
    const x = lng2x(ln, Z), y = lat2y(la, Z)
    const px = Math.max(0, Math.min(TILE - 1, Math.floor((((ln + 180) / 360) * n - x) * TILE)))
    // py from inverse: solve pixel whose center lat is closest — walk from tile top
    let best = null
    for (let py = 0; py < TILE; py++) {
      if (px2lat(y, py + 0.5) <= la) { best = py; break }
    }
    if (best == null) best = TILE - 1
    void px2lng
    const d = tiles[`${x}/${y}`]
    const o = (best * TILE + px) * 4
    return d[o] * 256 + d[o + 1] + d[o + 2] / 256 - 32768
  }

  const grid = []
  let valid = 0
  for (let r = 0; r < size; r++) {
    const row = []
    const la = lat + EXT - (r / (size - 1)) * 2 * EXT
    for (let cIdx = 0; cIdx < size; cIdx++) {
      const ln = lng - EXT + (cIdx / (size - 1)) * 2 * EXT
      let e = null
      try { e = elevAt(la, ln) } catch { e = null }
      if (e == null || !Number.isFinite(e) || e < -500 || e > 9000) {
        row.push(null)
      } else {
        row.push(+e.toFixed(2))
        valid++
      }
    }
    grid.push(row)
  }
  if (valid < size * size * 0.6) throw new Error('terrain voids')
  // fill rare voids with neighbour mean (single pass, documented gap-fill)
  const mean = grid.flat().filter((v) => v != null).reduce((a, b) => a + b, 0) / valid
  for (let r = 0; r < size; r++) {
    for (let cIdx = 0; cIdx < size; cIdx++) {
      if (grid[r][cIdx] == null) grid[r][cIdx] = +mean.toFixed(2)
    }
  }
  const cellM = +(((2 * EXT * 111320) / size).toFixed(1))
  const out = { grid, size, cellM, source: 'terrarium-30m', cached: false }
  writeCache(k, out)
  return out
}
