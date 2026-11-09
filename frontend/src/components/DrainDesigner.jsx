import { useState } from 'react'
import { mlDirect } from '../api'

/* Internal drain designer: size the site's own storm run for a design storm.
   Pure physics endpoint (no ML model) — roof + paved runoff vs RCC barrels. */
export default function DrainDesigner({ roofSqm = 800, pavedSqm = 400 }) {
  const [roof, setRoof] = useState(roofSqm)
  const [paved, setPaved] = useState(pavedSqm)
  const [rain, setRain] = useState(100)
  const [slope, setSlope] = useState(200) // 1 in N
  const [out, setOut] = useState(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const run = async () => {
    setBusy(true)
    setErr('')
    try {
      const r = await mlDirect.post('/design-drains', {
        roof_sqm: Number(roof), paved_sqm: Number(paved),
        design_rain_mmh: Number(rain), slope_frac: 1 / Number(slope),
      }, { timeout: 12000 })
      setOut(r.data)
    } catch {
      setErr('Drain engine unreachable — is ml-service :8000 running?')
      setOut(null)
    }
    setBusy(false)
  }

  const num = (v, setV, label) => (
    <label className="block text-xs text-slate-300">
      <span className="flex justify-between mb-1"><span>{label}</span><b className="font-num text-teal-300">{v}</b></span>
      <input type="number" value={v} min={0} onChange={(e) => setV(Number(e.target.value))}
        className="field !py-1.5" />
    </label>
  )

  return (
    <div className="grid sm:grid-cols-2 gap-4">
      <div className="space-y-2.5">
        {num(roof, setRoof, 'Roof area (m²)')}
        {num(paved, setPaved, 'Paved / driveway (m²)')}
        {num(rain, setRain, 'Design storm (mm/hr)')}
        {num(slope, setSlope, 'Bed slope 1 in N')}
        <button onClick={run} disabled={busy}
          className="bg-cyan-400 text-[#0b1526] px-4 py-2 rounded-xl font-bold text-sm disabled:opacity-50 w-full">
          {busy ? 'Sizing…' : 'Size my internal drain →'}
        </button>
        {err && <div className="text-[11px] text-red-300">{err}</div>}
      </div>
      <div>
        {!out ? (
          <div className="text-[12px] text-slate-500 bg-white/[.03] border border-white/10 rounded-xl p-4 h-full">
            Sizes the site's internal RCC storm run for the design storm — the complement to the municipal capacity check. Defaults preload from your footprint.
          </div>
        ) : (
          <div className="bg-cyan-500/[.07] border border-cyan-400/30 rounded-xl p-4 space-y-1.5">
            <div className="font-num text-3xl font-bold text-cyan-200">
              {out.runs > 1 ? `2 × ${out.dia_mm} mm` : `${out.dia_mm} mm RCC`}
            </div>
            <div className="text-[12px] text-slate-300 font-num">
              Q {out.q_m3s} m³/s vs capacity {out.capacity_m3s} m³/s · velocity {out.velocity_ms} m/s {out.self_cleansing ? '· self-cleansing ✓' : '· silting risk ⚠'}
            </div>
            <p className="text-[11px] text-slate-400 leading-relaxed">{out.note}</p>
            <p className="text-[10px] text-slate-500">{out.method}</p>
          </div>
        )}
      </div>
    </div>
  )
}
