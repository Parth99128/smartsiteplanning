/* Basement flood check for builders (planning-grade, documented model).
   Inflow = ramp/apron runoff at the design storm + seepage allowance.
   Q(lps) = C * i(mm/hr)/3600 * A(sqm) * 1000, C=0.9 paved, seepage +15%.
   Pumps pass when installed rate >= 1.25x inflow (duty+standby practice).
   Ramp crest must stand above local sheet-flow depth (0.45 m default). */

/* inputs: { levels, pumpLps, rampCrestM, apronSqm, designRainMmHr } */
export function basementVerdict(inp = {}) {
  const levels = Math.max(0, Math.min(3, Math.round(Number(inp.levels) || 0)))
  if (!levels) {
    return { levels: 0, verdict: 'none', inflowLps: 0, requiredLps: 0, checks: [] }
  }
  const rain = Math.max(25, Math.min(200, Number(inp.designRainMmHr) || 100))
  const apron = Math.max(0, Number(inp.apronSqm) || 0)
  const pump = Math.max(0, Number(inp.pumpLps) || 0)
  const crest = Number(inp.rampCrestM ?? 0.45)
  // Q(L/s) = C * i(mm/hr)/3600 [mm/s] * A(m²); 1 mm over 1 m² = 1 L. +15% seepage.
  const inflow = 0.9 * (rain / 3600) * apron * 1.15
  const required = inflow * 1.25
  const checks = [
    {
      id: 'pump', label: 'Dewatering ≥ 1.25× inflow',
      pass: pump >= required,
      detail: `inflow ~${inflow.toFixed(1)} L/s at ${rain} mm/hr → need ≥${required.toFixed(1)} L/s, have ${pump} L/s`,
    },
    {
      id: 'ramp', label: 'Ramp crest ≥ 0.45 m above road',
      pass: crest >= 0.45,
      detail: `crest ${Number(crest).toFixed(2)} m ${crest >= 0.45 ? 'holds back street sheet-flow' : 'lets street runoff pour in — raise the crest'}`,
    },
    {
      id: 'power', label: 'Standby pump + power',
      pass: pump >= required * 2 || !!inp.standby,
      detail: pump >= required * 2
        ? 'installed rate covers duty + standby'
        : 'provide 100% standby pump on auto + generator backup (confirm in design)',
    },
  ]
  const verdict = checks.every((c) => c.pass) ? 'safe' : 'unsafe'
  return {
    levels, verdict,
    inflowLps: +inflow.toFixed(1), requiredLps: +required.toFixed(1),
    checks,
    note: verdict === 'safe'
      ? `Basement dewatering covers a ${rain} mm/hr design storm with margin.`
      : 'Basement WILL flood at the design storm as specified — upsize pumps / crest before sanction drawings.',
  }
}
