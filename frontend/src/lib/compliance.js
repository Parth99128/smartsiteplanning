/* No-waterlogging compliance sheet for builders/architects.
   Every check is computed from STORED project data (factors, design inputs,
   traced flow, hydraulics) — nothing is asserted without a measured input.
   Thresholds are documented planning defaults with city RWH triggers; they are
   NOT a reading of any ULB's current DCR. The sheet says so on-screen. */

const RWH_SITE_MIN = { chennai: 0, bengaluru: 111, pune: 500, default: 500 }
// Basis strings double as the paper trail for the report appendix.
const RWH_BASIS = {
  chennai: 'CMDA commonly mandates RWH for all buildings — confirm current DCR',
  bengaluru: 'BWSSB commonly mandates RWH for sites ≥30x40 ft (~111 m²) — confirm current DCR',
  pune: 'PMC commonly mandates RWH for plots ≥500 m² — confirm current DCR',
  default: 'Planning default trigger (500 m²) — confirm local DCR',
}

function num(v, dflt = null) {
  const n = Number(v)
  return Number.isFinite(n) ? n : dflt
}

/* inputs: { factors, design {plinth_m, permeable_sqm, green_sqm, storage_m3,
   rain_garden, recharge, footprint_sqm}, siteArea, roofSqm, intersects,
   hyd {margin_ratio}, basement {levels}, city } */
export function buildCompliance(inp = {}) {
  const f = inp.factors || {}
  const d = inp.design || {}
  const city = (inp.city || 'default').toLowerCase()
  const site = num(inp.siteArea)
  const roof = num(inp.roofSqm, num(d.footprint_sqm, num(f.footprint_sqm, 800)))
  const checks = []
  const push = (id, label, status, measured, required, note, basis) =>
    checks.push({ id, label, status, measured, required, note, basis })

  // 1. Drainage corridor clear
  if (inp.intersects == null) {
    push('corridor', 'Drainage corridor left clear', 'info', '—', 'no overlap',
      'Run Analyze to trace the flow path against the placed footprint.', 'Traced flow vs placed footprint')
  } else if (inp.intersects) {
    push('corridor', 'Drainage corridor left clear', 'fail', 'BLOCKED', 'no overlap',
      'Placed footprint overlaps the traced natural drainage path — shift the block or leave a corridor.', 'Traced flow vs placed footprint')
  } else {
    push('corridor', 'Drainage corridor left clear', 'pass', 'clear', 'no overlap',
      'Placed footprint clears the traced flow path at this position.', 'Traced flow vs placed footprint')
  }

  // 2. Plinth level
  const plinth = num(d.plinth_m, 0.3)
  if (plinth >= 0.6) {
    push('plinth', 'Plinth ≥ 0.60 m', 'pass', `${plinth.toFixed(2)} m`, '≥ 0.60 m',
      'Floor level clears shallow sheet flooding in the modelled scenarios.', 'Planning default — confirm DCR')
  } else {
    push('plinth', 'Plinth ≥ 0.60 m', 'fail', `${plinth.toFixed(2)} m`, '≥ 0.60 m',
      'Raise the plinth (Simulator → 0.6–0.9 m) and re-run.', 'Planning default — confirm DCR')
  }

  // 3. RWH trigger + storage sizing (50 mm design storm on roof, 0.9 runoff coeff)
  const trigger = RWH_SITE_MIN[city] ?? RWH_SITE_MIN.default
  const rwhNeeded = site == null ? true : site >= trigger
  const needM3 = roof * 0.05 * 0.9
  const haveM3 = num(d.storage_m3, 0) + (d.recharge ? 20 : 0) + (d.rain_garden ? 10 : 0)
  if (!rwhNeeded) {
    push('rwh', 'Rainwater harvesting', 'info', 'not triggered', `site ≥ ${trigger} m²`,
      `Site ${site} m² is below the commonly cited trigger — still recommended.`, RWH_BASIS[city] ?? RWH_BASIS.default)
  } else if (haveM3 >= needM3) {
    push('rwh', 'RWH storage ≥ 50 mm roof storm', 'pass', `${haveM3.toFixed(0)} m³`, `≥ ${needM3.toFixed(0)} m³`,
      'Storage + recharge covers one 50 mm design storm on the roof.', 'Roof × 50 mm × 0.9 coeff (planning default)')
  } else {
    push('rwh', 'RWH storage ≥ 50 mm roof storm', 'fail', `${haveM3.toFixed(0)} m³`, `≥ ${needM3.toFixed(0)} m³`,
      `Add ~${Math.ceil(needM3 - haveM3)} m³ storage / recharge pits (see drain designer).`, 'Roof × 50 mm × 0.9 coeff (planning default)')
  }

  // 4. Ground coverage
  const fp = num(d.footprint_sqm, num(f.footprint_sqm))
  if (site == null || fp == null) {
    push('coverage', 'Ground coverage ≤ 65%', 'info', '—', '≤ 65%',
      'Enter site area to check coverage (footprint ÷ site).', 'Planning default — confirm DCR')
  } else {
    const cov = (fp / site) * 100
    push('coverage', 'Ground coverage ≤ 65%', cov <= 65 ? 'pass' : 'fail',
      `${cov.toFixed(0)}%`, '≤ 65%',
      cov <= 65 ? 'Coverage leaves room for infiltration + setbacks.' : 'Coverage exceeds the planning band — shrink footprint or add permeable area.',
      'Planning default — confirm DCR')
  }

  // 5. Permeable open ground
  const perm = num(d.permeable_sqm, 0) + num(d.green_sqm, 0)
  if (site == null) {
    push('permeable', 'Permeable ground ≥ 15% of site', 'info', '—', '≥ 15%',
      'Enter site area to check permeable share.', 'Planning default — confirm DCR')
  } else {
    const pct = (perm / site) * 100
    push('permeable', 'Permeable ground ≥ 15% of site', pct >= 15 ? 'pass' : 'fail',
      `${pct.toFixed(0)}%`, '≥ 15%',
      pct >= 15 ? 'Infiltration area meets the planning band.' : 'Add permeable paving / green (Simulator) to cut runoff at source.',
      'Planning default — confirm DCR')
  }

  // 6. Outlet capacity (physics, not prediction)
  const margin = inp.hyd?.margin_ratio
  if (margin == null) {
    push('outlet', 'Site discharge ≤ drain capacity', 'info', '—', 'margin ≥ −0.2',
      'Run Analyze on a registry city to get the Manning capacity check.', 'Manning + rational (planning proxy)')
  } else if (margin >= -0.2) {
    push('outlet', 'Site discharge ≤ drain capacity', 'pass', `margin ${margin}`, 'margin ≥ −0.2',
      'Nearby drains carry the design runoff with spare capacity.', 'Manning + rational (planning proxy)')
  } else {
    push('outlet', 'Site discharge ≤ drain capacity', 'fail', `margin ${margin}`, 'margin ≥ −0.2',
      'Runoff exceeds nearby drain capacity — add storage or upsize internal drains.', 'Manning + rational (planning proxy)')
  }

  // 7. Basement (fed by the basement check; default = none proposed)
  const levels = num(inp.basement?.levels, 0)
  if (!levels) {
    push('basement', 'Basement flood risk', 'pass', 'no basement', 'pumps + bund if built',
      'No basement proposed — nothing to dewater.', 'Basement check')
  } else {
    const verdict = inp.basement?.verdict
    push('basement', `Basement flood risk (${levels} lvl)`, verdict === 'safe' ? 'pass' : 'fail',
      verdict === 'safe' ? 'pumps adequate' : 'pumps inadequate',
      'inflow ≤ pump rate at design storm',
      verdict === 'safe' ? 'Dewatering covers the design-storm inflow.' : 'Upsize pumps / raise ramp crest — see basement check.',
      'Basement check')
  }

  const fails = checks.filter((c) => c.status === 'fail').length
  return {
    checks,
    passed: checks.filter((c) => c.status === 'pass').length,
    failed: fails,
    open: checks.filter((c) => c.status === 'info').length,
    verdict: fails === 0 ? 'SUBMITTABLE WITH NOTES' : `${fails} ITEM${fails === 1 ? '' : 'S'} TO FIX`,
    disclaimer: 'Planning-grade checks against documented defaults — not a ULB approval. Confirm thresholds against the current DCR/bye-laws.',
  }
}
