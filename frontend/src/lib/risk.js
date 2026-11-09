/* FloodShield risk helpers — single source of truth for levels, badges, scenario math. */

export function levelOf(score) {
  const s = Number(score ?? 0)
  if (s < 35) return 'Low'
  if (s < 60) return 'Moderate'
  if (s < 80) return 'High'
  return 'Severe'
}

export function levelColor(score) {
  const s = Number(score ?? 0)
  if (s > 80) return 'text-red-400'
  if (s > 60) return 'text-orange-300'
  if (s > 35) return 'text-amber-300'
  return 'text-emerald-300'
}

export const BADGE_TIERS = ['Bronze', 'Silver', 'Gold', 'Platinum']
const BADGE_MIN = { Bronze: 0, Silver: 40, Gold: 60, Platinum: 80 }

export function nextBadge(resilience) {
  const r = Number(resilience ?? 0)
  for (const t of ['Platinum', 'Gold', 'Silver']) {
    if (r < BADGE_MIN[t]) return { next: t, gap: +(BADGE_MIN[t] - r).toFixed(1) }
  }
  return { next: null, gap: 0 }
}

/* Flood forcing → visible water rise in the 3D twin (meters).
   surgeM: storm-surge / outlet backwater. blockedPct: clogged drains.
   climate: rainfall uplift % (also sent to the ML simulate endpoint). */
export function effectiveRiseM(climatePct = 0, scenario = {}) {
  const surge = Number(scenario.surgeM ?? 0)
  const blocked = Number(scenario.blockedPct ?? 0)
  return +((surge + (blocked / 100) * 1.2 + (Number(climatePct) / 100) * 0.8).toFixed(2))
}

/* Planning-grade cost model (bands, kept consistent with ML gain_pts). */
export function costEstimate(inputs = {}) {
  const permeable = Number(inputs.permeable_sqm ?? 0)
  const storage = Number(inputs.storage_m3 ?? 0)
  const plinth = Number(inputs.plinth_m ?? 0)
  let low = 0, high = 0
  low += permeable * 900; high += permeable * 1400
  low += storage * 12000; high += storage * 18000
  if (inputs.rain_garden) { low += 45000; high += 80000 }
  if (inputs.recharge) { low += 30000; high += 55000 }
  if (plinth > 0.45) { low += (plinth - 0.45) * 180000; high += (plinth - 0.45) * 260000 }
  const fmtL = (v) => (v >= 100000 ? `₹${(v / 100000).toFixed(1)}L` : `₹${Math.round(v / 1000)}k`)
  return { low: Math.round(low), high: Math.round(high), label: `${fmtL(low)} – ${fmtL(high)} (estimated)` }
}

export function buildSummary({ risk, level, res, badge, topF = [], recCount = 0, climate = 0, scenario = {}, flagCount = 0 }) {
  const rise = effectiveRiseM(climate, scenario)
  const drivers = topF.length ? topF.join(', ') : 'impervious cover, drainage density, distance to water'
  return (
    `Plot scores ${risk ?? '—'} (${level ?? '—'}) flood risk` +
    (res != null ? ` with ${res} resilience (${badge ?? 'Bronze'}).` : '.') +
    ` Dominant drivers: ${drivers}.` +
    (flagCount ? ` ${flagCount} red flag${flagCount === 1 ? '' : 's'} require attention.` : ' No blocking red flags.') +
    (climate ? ` Under +${climate}% rainfall with ${rise}m modelled water rise,` : ' At baseline rainfall,') +
    ` ${recCount} intervention${recCount === 1 ? '' : 's'} are recommended (see table).` +
    ` Planning-grade estimate — verify with a licensed engineer.`
  )
}

export function toCSV(rows) {
  const head = ['plot', 'risk', 'level', 'resilience', 'badge', 'top_factors']
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`
  return [head.join(','), ...rows.map((r) => head.map((k) => esc(r[k])).join(','))].join('\n')
}

export function download(filename, text, mime = 'text/plain') {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = filename
  document.body.appendChild(a); a.click()
  setTimeout(() => { URL.revokeObjectURL(url); a.remove() }, 400)
}
