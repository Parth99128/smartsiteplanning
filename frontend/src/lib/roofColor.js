/* Rooftop colors sampled from Esri World Imagery (keyless, CORS-open).
   Each building's roof takes the dominant satellite pixel color at its
   centroid, so the twin matches the real site: terracotta, concrete grey,
   blue sheet metal, green tarps. Walls get a shaded variant of the same hue.
   In-memory tile cache per session; null per building on any failure. */

const Z = 17 // ~1.1 m/px at Indian latitudes — enough for dominant roof tone
const TILE = 256
const TERR = (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`

const tileCache = new Map()

const lng2x = (lng, z) => Math.floor(((lng + 180) / 360) * 2 ** z)
const lat2y = (lat, z) => {
  const r = (lat * Math.PI) / 180
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z)
}

function loadTile(z, x, y, signal) {
  const k = `${z}/${x}/${y}`
  if (tileCache.has(k)) return tileCache.get(k)
  const p = new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    const to = setTimeout(() => reject(new Error('tile timeout')), 8000)
    img.onload = () => {
      clearTimeout(to)
      try {
        const c = document.createElement('canvas')
        c.width = TILE
        c.height = TILE
        const g = c.getContext('2d', { willReadFrequently: true })
        g.drawImage(img, 0, 0)
        resolve(g.getImageData(0, 0, TILE, TILE))
      } catch (e) { reject(e) }
    }
    img.onerror = () => { clearTimeout(to); reject(new Error('tile failed')) }
    if (signal?.aborted) return reject(new DOMException('aborted', 'AbortError'))
    signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    img.src = TERR(z, x, y)
  })
  tileCache.set(k, p)
  // evict failures so retries can refetch
  p.catch(() => tileCache.delete(k))
  return p
}

/* buildings: [{poly:[[nx,ny]...], ...}] in 0..1 site frame around siteLat/Lng.
   Returns array of {roof:[r,g,b], wall:[r,g,b]} (0..1 floats) or null entries. */
export async function sampleRoofColors(buildings, siteLat, siteLng, signal) {
  const lat0 = Number(siteLat) - 0.005, lng0 = Number(siteLng) - 0.005
  const toLatLng = ([nx, ny]) => [lat0 + ny * 0.01, lng0 + nx * 0.01]
  const out = new Array(buildings.length).fill(null)
  try {
    // group centroid tile lookups
    const jobs = buildings.map((b, i) => {
      const c = centroid(b.poly)
      if (!c) return null
      const [la, ln] = toLatLng(c)
      return { i, la, ln, x: lng2x(ln, Z), y: lat2y(la, Z) }
    }).filter(Boolean)
    // Parallel fetch: sequential awaits × slow tiles tripped the 30 s abort
    // and left every roof grey. allSettled keeps the survivors.
    const keys = [...new Set(jobs.map((j) => `${j.x}/${j.y}`))]
    const settled = await Promise.all(keys.map((k) => {
      const [x, y] = k.split('/').map(Number)
      return loadTile(Z, x, y, signal).then((d) => [k, d]).catch(() => [k, null])
    }))
    const tiles = Object.fromEntries(settled)
    const n = 2 ** Z
    for (const j of jobs) {
      const img = tiles[`${j.x}/${j.y}`]
      if (!img) continue
      const px = Math.max(0, Math.min(TILE - 1, Math.floor((((j.ln + 180) / 360) * n - j.x) * TILE)))
      // find row by latitude scan (same approach as terrain sampler)
      const m = Math.PI * (1 - 2 * (((j.y) / n)))
      void m
      let best = null
      for (let py = 0; py < TILE; py++) {
        const t = (j.y + (py + 0.5) / TILE) / n
        const la = (Math.atan(Math.sinh(Math.PI * (1 - 2 * t))) * 180) / Math.PI
        if (la <= j.la) { best = py; break }
      }
      if (best == null) best = TILE - 1
      // 3×3 average to denoise vents/shadows
      let r = 0, g = 0, b = 0, c = 0
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const xx = Math.max(0, Math.min(TILE - 1, px + dx))
          const yy = Math.max(0, Math.min(TILE - 1, best + dy))
          const o = (yy * TILE + xx) * 4
          r += img.data[o]; g += img.data[o + 1]; b += img.data[o + 2]; c++
        }
      }
      r /= c * 255; g /= c * 255; b /= c * 255
      // wall = same hue, darker + desaturated toward grey
      const lum = 0.299 * r + 0.587 * g + 0.114 * b
      out[j.i] = {
        roof: [r, g, b],
        wall: [r * 0.55 + lum * 0.2, g * 0.55 + lum * 0.2, b * 0.55 + lum * 0.2],
      }
    }
  } catch { /* per-building nulls already in place */ }
  return out
}

function centroid(poly) {
  if (!poly?.length) return null
  let x = 0, y = 0
  for (const p of poly) { x += p[0]; y += p[1] }
  return [x / poly.length, y / poly.length]
}
