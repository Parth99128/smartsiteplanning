import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { apiPost } from '../lib/api'
import { costEstimate } from '../lib/risk'
import { basementVerdict } from '../lib/basement'

const PRESETS = {
  Baseline: { footprint_sqm: 800, plinth_m: 0.3, permeable_sqm: 300, storage_m3: 20, rain_garden: true, recharge: false },
  'Monsoon-Ready': { footprint_sqm: 750, plinth_m: 0.9, permeable_sqm: 800, storage_m3: 60, rain_garden: true, recharge: true },
  'Sponge Plot': { footprint_sqm: 650, plinth_m: 0.6, permeable_sqm: 1100, storage_m3: 100, rain_garden: true, recharge: true },
  Minimal: { footprint_sqm: 900, plinth_m: 0.15, permeable_sqm: 100, storage_m3: 0, rain_garden: false, recharge: false },
}

/* What-If simulator: debounced live runs, presets, indicative cost, delta vs baseline. */
export default function Simulator({ onSim }) {
  const { activeId, climate, set, simInputs, simulation, analysis } = useStore()
  const [f, setF] = useState(simInputs)
  const [preset, setPreset] = useState('Baseline')
  const [pending, setPending] = useState(false)
  const timer = useRef(null)

  useEffect(() => { setF(simInputs) }, [simInputs.footprint_sqm, simInputs.plinth_m, simInputs.permeable_sqm, simInputs.storage_m3, simInputs.rain_garden, simInputs.recharge, simInputs.land_use_change_pct, simInputs.basement_levels, simInputs.basement_pump_lps, simInputs.basement_ramp_m, simInputs.basement_apron_sqm, simInputs.basement_standby]) // eslint-disable-line
  useEffect(() => () => clearTimeout(timer.current), [])

  const run = async (patch = {}) => {
    if (activeId == null) { set({ toast: 'Create a project first' }); return }
    const next = { ...f, ...patch }
    const body = { ...next, climate_uplift_pct: climate }
    set({ loading: true })
    try {
      const r = await apiPost(`/projects/${activeId}/simulate`, body)
      set({ simulation: r.data, simInputs: next })
      onSim?.(r.data)
    } catch { set({ toast: 'Simulator offline — check backend :8080' }) }
    set({ loading: false })
  }

  const queue = (patch) => {
    const next = { ...f, ...patch }
    setF(next)
    setPending(true)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => { setPending(false); run(patch) }, 550)
  }

  const applyPreset = (name) => {
    setPreset(name)
    const p = PRESETS[name]
    setF(p)
    run(p)
  }

  const slider = (k, min, max, step, unit = '') => (
    <label className="block text-xs text-slate-300">
      <span className="flex justify-between"><span>{k.replace(/_/g, ' ').replace('pct', '(%)')}</span>
        <b className="font-num text-teal-300">{String(f[k] ?? '')}{unit}</b></span>
      <input type="range" min={min} max={max} step={step} value={f[k] ?? min}
        onChange={(e) => queue({ [k]: Number(e.target.value) })} />
    </label>
  )

  const baseRisk = analysis?.risk?.risk_score
  const simRisk = simulation?.risk_score
  const gain = baseRisk != null && simRisk != null ? +(baseRisk - simRisk).toFixed(1) : null
  const cost = costEstimate(f)
  const bmt = basementVerdict({
    levels: f.basement_levels, pumpLps: f.basement_pump_lps,
    rampCrestM: f.basement_ramp_m, apronSqm: f.basement_apron_sqm,
    designRainMmHr: 100, standby: f.basement_standby,
  })
  const bmtVerdict = bmt.levels ? bmt.verdict : null

  return (
    <div className="glass p-5 space-y-3">
      <div className="flex items-center justify-between">
        <div className="font-bold">What-If Simulator <span className="text-xs text-slate-400 font-normal">+ climate toggle</span></div>
        {pending && <span className="text-[11px] text-slate-400">⏳ debounced…</span>}
      </div>
      <div className="flex gap-1.5 flex-wrap">
        {Object.keys(PRESETS).map((p) => (
          <button key={p} onClick={() => applyPreset(p)}
            className={`px-2.5 py-1 rounded-full text-[11px] font-bold ${preset === p ? 'bg-violet-400 text-[#0b1526]' : 'bg-white/10 hover:bg-white/20'}`}>{p}</button>
        ))}
      </div>
      <div className="flex gap-2">
        {[0, 10, 25].map((v) => (
          <button key={v} onClick={() => { set({ climate: v }); run({}) }}
            className={`px-3 py-1 rounded-full text-xs font-bold ${climate === v ? 'bg-teal-400 text-[#0b1526]' : 'bg-white/10 hover:bg-white/20'}`}>+{v}% rain</button>
        ))}
      </div>
      {slider('footprint_sqm', 200, 1500, 10, ' m²')}
      {slider('plinth_m', 0, 1.2, 0.05, ' m')}
      {slider('permeable_sqm', 0, 1200, 10, ' m²')}
      {slider('storage_m3', 0, 150, 5, ' m³')}
      {slider('land_use_change_pct', 0, 95, 1, '%')}
      <div className="flex gap-3 text-xs">
        <label className="flex gap-1.5 items-center cursor-pointer"><input type="checkbox" checked={f.rain_garden} onChange={(e) => queue({ rain_garden: e.target.checked })} className="accent-teal-400" /> rain garden</label>
        <label className="flex gap-1.5 items-center cursor-pointer"><input type="checkbox" checked={f.recharge} onChange={(e) => queue({ recharge: e.target.checked })} className="accent-teal-400" /> recharge pits</label>
      </div>
      <div className="border-t border-white/10 pt-2 space-y-2">
        <div className="text-xs font-bold text-slate-200">Basement flood check <span className="font-normal text-slate-500">· 100 mm/hr design storm</span></div>
        {slider('basement_levels', 0, 3, 1, ' lvl')}
        {(f.basement_levels ?? 0) > 0 && (
          <>
            {slider('basement_pump_lps', 0, 60, 1, ' L/s')}
            {slider('basement_ramp_m', 0, 1, 0.05, ' m crest')}
            {slider('basement_apron_sqm', 0, 2000, 10, ' m² apron')}
            <label className="flex gap-1.5 items-center cursor-pointer text-xs"><input type="checkbox" checked={!!f.basement_standby} onChange={(e) => queue({ basement_standby: e.target.checked })} className="accent-teal-400" /> 100% standby pump + generator</label>
            <div className={`rounded-xl border px-3 py-2 text-[11px] ${bmtVerdict === 'safe' ? 'bg-emerald-500/10 border-emerald-400/30 text-emerald-200' : 'bg-red-500/10 border-red-400/30 text-red-200'}`}>
              <b>{bmtVerdict === 'safe' ? '✓ Dewatering covers the design storm' : '✕ Basement WILL flood at design storm'}</b>
              <div className="mt-1 space-y-0.5 opacity-90">
                {bmt.checks.map((c) => <div key={c.id}>{c.pass ? '✓' : '✕'} {c.label} — {c.detail}</div>)}
              </div>
            </div>
          </>
        )}
      </div>
      <div className="flex items-center justify-between text-xs border-t border-white/10 pt-2">
        <span className="text-slate-400">Estimated cost <b className="text-slate-200">{cost.label}</b></span>
        {gain != null && (
          <span className={`font-bold font-num ${gain >= 0 ? 'text-emerald-300' : 'text-red-300'}`}>
            {gain >= 0 ? '−' : '+'}{Math.abs(gain)} risk pts vs baseline
          </span>
        )}
      </div>
    </div>
  )
}
