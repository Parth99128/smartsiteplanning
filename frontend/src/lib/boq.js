/* BOQ costing for builders: line items from the simulated design × editable
   unit rates (persisted locally). Defaults are all-India planning bands —
   architects overwrite with their city's PWD schedule rates. Amounts are
   estimates, never quotations. */

const RATES_KEY = 'floodshield-boq-rates-v1'

export const DEFAULT_RATES = {
  permeable_paving_m2: 1150, // interlocking permeable pavers laid
  rain_garden_no: 60000, // per garden with media + planting
  recharge_pit_no: 42000, // per pit with filter media
  storage_tank_m3: 15000, // underground RCC sump
  plinth_raise_m: 180000, // per metre height over the footprint
  pump_set_lps: 3000, // per L/s installed (pump + piping share)
  pump_standby_lump: 60000, // standby set + auto panel share
}

export function loadRates() {
  try {
    const raw = JSON.parse(localStorage.getItem(RATES_KEY) || '{}')
    return { ...DEFAULT_RATES, ...raw }
  } catch { return { ...DEFAULT_RATES } }
}

export function saveRates(rates) {
  try { localStorage.setItem(RATES_KEY, JSON.stringify(rates)) } catch { /* private mode */ }
}

/* design: simInputs-like. basement: {levels, pumpLps, standby}. */
export function buildBOQ(design = {}, basement = {}, rates = DEFAULT_RATES) {
  const L = (item, qty, unit, rate) => ({
    item, qty: +Number(qty).toFixed(2), unit, rate: Math.round(rate),
    amount: Math.round(Number(qty) * rate),
  })
  const lines = []
  const perm = Number(design.permeable_sqm) || 0
  if (perm > 0) lines.push(L('Permeable paving', perm, 'm²', rates.permeable_paving_m2))
  if (design.rain_garden) lines.push(L('Rain garden', 1, 'no', rates.rain_garden_no))
  // Site-plan assets win over the boolean: drawn pit count replaces the default pair.
  const pits = design.recharge_pits ?? (design.recharge ? 2 : 0)
  if (pits > 0) lines.push(L(`Recharge pits (${pits} nos)`, pits, 'nos', rates.recharge_pit_no))
  const stor = Number(design.storage_m3) || 0
  if (stor > 0) lines.push(L('Storm storage sump', stor, 'm³', rates.storage_tank_m3))
  const extra = Math.max(0, (Number(design.plinth_m) || 0) - 0.45)
  if (extra > 0) lines.push(L('Plinth raise above 0.45 m', extra, 'm height', rates.plinth_raise_m))
  const pump = Number(basement.pumpLps) || 0
  if (pump > 0) lines.push(L('Dewatering pump set', pump, 'L/s installed', rates.pump_set_lps))
  if (basement.standby) lines.push(L('Standby pump + auto panel', 1, 'lot', rates.pump_standby_lump))
  const total = lines.reduce((a, l) => a + l.amount, 0)
  return { lines, total, note: 'Estimate from editable planning rates — not a quotation. Confirm against current PWD schedule.' }
}

export function boqCSV(boq) {
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`
  const head = 'item,qty,unit,rate_inr,amount_inr'
  const rows = boq.lines.map((l) => [l.item, l.qty, l.unit, l.rate, l.amount].map(esc).join(','))
  return [head, ...rows, `"TOTAL",,,,${boq.total}`].join('\n')
}
