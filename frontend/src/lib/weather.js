/* Live atmosphere: Open-Meteo nowcast + hourly forecast (keyless, CORS-open).
   Answers "what is the sky doing over THIS pin right now" so builders test
   their design against the live storm, not just a manual slider.
   Cached 15 min per pin; null on failure (tool keeps working offline). */

const KEY = (lat, lng) => `wx-v1-${Number(lat).toFixed(2)},${Number(lng).toFixed(2)}`

function readCache(k) {
  try {
    const j = JSON.parse(sessionStorage.getItem(k))
    if (j && Date.now() - j.ts < 15 * 60 * 1000) return j.data
  } catch { /* miss */ }
  return null
}

function writeCache(k, data) {
  try { sessionStorage.setItem(k, JSON.stringify({ ts: Date.now(), data })) } catch { /* quota */ }
}

export async function fetchWeather(lat, lng, signal) {
  const la = Number(lat), ln = Number(lng)
  if (!Number.isFinite(la) || !Number.isFinite(ln)) return null
  const k = KEY(la, ln)
  const hit = readCache(k)
  if (hit) return { ...hit, cached: true }
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${la.toFixed(4)}&longitude=${ln.toFixed(4)}`
    + `&current=precipitation,weather_code&hourly=precipitation&forecast_days=2&timezone=auto`
  const r = await fetch(url, { signal, headers: { Accept: 'application/json' } })
  if (!r.ok) throw new Error(`weather ${r.status}`)
  const j = await r.json()
  const now = Number(j.current?.precipitation ?? 0)
  const hours = (j.hourly?.precipitation || []).map(Number).filter(Number.isFinite).slice(0, 24)
  const next24 = hours.reduce((a, b) => a + b, 0)
  const peak = hours.length ? Math.max(...hours) : 0
  const data = {
    rainingNowMmHr: +now.toFixed(1),
    next24hMm: +next24.toFixed(1),
    peakHourMmHr: +peak.toFixed(1),
    code: j.current?.weather_code ?? null,
    // Design-storm equivalent of the live sky: what daily total to test.
    testRainMm: Math.max(50, Math.round(next24)),
    cached: false,
  }
  writeCache(k, data)
  return data
}

export function codeLabel(code) {
  if (code == null) return '—'
  if (code === 0) return 'Clear'
  if (code <= 3) return 'Cloudy'
  if (code <= 48) return 'Fog'
  if (code <= 57) return 'Drizzle'
  if (code <= 67) return 'Rain'
  if (code <= 77) return 'Snow grains'
  if (code <= 82) return 'Showers'
  return 'Thunderstorm'
}
