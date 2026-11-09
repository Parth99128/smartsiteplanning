import { useEffect, useRef } from 'react'
import { useStore } from '../store'
import { effectiveRiseM } from '../lib/risk'

/* Flood-forcing scenario bar. Rainfall uplift re-runs the ML model (debounced);
   surge + blocked drains are visual forcing applied to the 3D twin's water level. */
export default function ScenarioBar() {
  const { climate, scenario, set, simulate } = useStore()
  const timer = useRef(null)

  const queueSim = () => {
    clearTimeout(timer.current)
    timer.current = setTimeout(() => { simulate().catch(() => {}) }, 650)
  }
  useEffect(() => () => clearTimeout(timer.current), [])

  const rise = effectiveRiseM(climate, scenario)
  const slider = (label, val, min, max, step, onChange, unit = '') => (
    <label className="block text-xs text-slate-300">
      <span className="flex justify-between"><span>{label}</span><b className="font-num text-cyan-300">{val}{unit}</b></span>
      <input type="range" min={min} max={max} step={step} value={val}
        onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  )

  return (
    <div className="glass p-5 space-y-3">
      <div className="flex items-center justify-between">
        <div className="font-bold">Flood Scenario <span className="text-xs text-slate-400 font-normal">forcing → 3D water</span></div>
        <div className="text-xs font-num px-2.5 py-1 rounded-full bg-cyan-500/15 border border-cyan-400/30 text-cyan-300">
          +{rise.toFixed(2)} m in twin
        </div>
      </div>
      <div className="flex gap-2 flex-wrap">
        {[0, 10, 25, 40].map((v) => (
          <button key={v} onClick={() => { set({ climate: v }); queueSim() }}
            className={`px-3 py-1 rounded-full text-xs font-bold ${climate === v ? 'bg-teal-400 text-[#0b1526]' : 'bg-white/10 hover:bg-white/20'}`}>
            +{v}% rain
          </button>
        ))}
      </div>
      {slider('Storm surge / backwater', scenario.surgeM, 0, 2, 0.1, (v) => set({ scenario: { ...scenario, surgeM: v } }), ' m')}
      {slider('Drains blocked', scenario.blockedPct, 0, 100, 5, (v) => set({ scenario: { ...scenario, blockedPct: v } }), '%')}
      <div className="flex gap-2">
        <button onClick={() => set({ scenario: { surgeM: 0, blockedPct: 0 }, climate: 0 })}
          className="text-xs bg-white/10 hover:bg-white/20 px-3 py-1.5 rounded-full">Reset forcing</button>
      </div>
      <p className="text-[11px] text-slate-500">Rainfall uplift re-runs the ML model. Surge + blockage raise the twin's water plane and are recorded in report assumptions.</p>
    </div>
  )
}
