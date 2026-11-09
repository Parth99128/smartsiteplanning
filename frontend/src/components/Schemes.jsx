import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { apiGet, apiPost, apiDelete, serverMessage } from '../lib/api'
import { levelOf } from '../lib/risk'

const SCHEME_NAMES = ['Scheme A', 'Scheme B', 'Scheme C', 'Scheme D', 'Scheme E', 'Scheme F']

/* Architect optioneering: snapshot the current simulator design as a named
   scheme, compare A/B/C side by side, reload any of them into the simulator. */
export default function Schemes() {
  const { activeId, simInputs, climate, set, notify } = useStore()
  const simulate = useStore((s) => s.simulate)
  const [schemes, setSchemes] = useState([])
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const load = async () => {
    if (activeId == null) return
    try {
      const r = await apiGet(`/projects/${activeId}/schemes`)
      setSchemes(Array.isArray(r.data) ? r.data : [])
    } catch { /* 005 missing or offline — empty list */ }
  }
  useEffect(() => { setSchemes([]); setName(''); load() }, [activeId]) // eslint-disable-line

  const save = async () => {
    if (activeId == null) return
    setBusy(true)
    setErr('')
    try {
      const input = { ...simInputs, climate_uplift_pct: climate }
      Object.keys(input).forEach((k) => { if (k.startsWith('_')) delete input[k] })
      const label = name.trim() || SCHEME_NAMES[schemes.length] || `Scheme ${schemes.length + 1}`
      await apiPost(`/projects/${activeId}/schemes`, { name: label, input })
      setName('')
      await load()
      notify(`Saved ${label} — scored against the same risk engine`, 'success')
    } catch (e) {
      setErr(serverMessage(e, 'Save failed — is the backend running?'))
    }
    setBusy(false)
  }

  const apply = async (s) => {
    const input = { ...(s.input || {}) }
    delete input.climate_uplift_pct
    set({ simInputs: { ...simInputs, ...input } })
    try {
      await simulate({})
      notify(`Loaded ${s.name} into the simulator`, 'success')
    } catch { /* simulate surfaces its own error */ }
  }

  const remove = async (s) => {
    try {
      await apiDelete(`/projects/${activeId}/schemes/${s.id}`)
      await load()
    } catch { setErr('Delete failed.') }
  }

  if (activeId == null) return null
  const bestRisk = schemes.length ? Math.min(...schemes.map((s) => s.result?.risk_score ?? 999)) : null
  const bestRes = schemes.length ? Math.max(...schemes.map((s) => s.result?.resilience_score ?? -1)) : null
  const metric = (label, fn, fmt = (v) => v) => (
    <tr key={label} className="border-b border-white/5 text-[11px]">
      <td className="py-1.5 pr-2 text-slate-400">{label}</td>
      {schemes.map((s) => <td key={s.id} className="py-1.5 pr-2 font-num text-slate-100">{fmt(fn(s))}</td>)}
    </tr>
  )

  return (
    <div>
      <div className="flex gap-2 flex-wrap items-center">
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60}
          placeholder={SCHEME_NAMES[schemes.length] || 'Scheme name'}
          className="field !w-44 !py-1.5" />
        <button onClick={save} disabled={busy || schemes.length >= 6}
          className="bg-violet-400 text-[#0b1526] px-4 py-1.5 rounded-xl font-bold text-sm disabled:opacity-50">
          {busy ? 'Scoring…' : '💾 Save current as scheme'}
        </button>
        <span className="text-[11px] text-slate-500">{schemes.length}/6 saved · each re-scored server-side</span>
      </div>
      {err && <div className="text-[11px] text-red-300 mt-1.5">{err}</div>}
      {!schemes.length ? (
        <div className="text-[12px] text-slate-500 mt-2 bg-white/[.03] border border-white/10 rounded-xl p-3">
          No schemes yet — tune the Simulator, then save the design as <b>Scheme A</b>, change massing (footprint / plinth / storage), save as <b>B</b>, and compare.
        </div>
      ) : (
        <div className="mt-2 overflow-auto">
          <table className="w-full min-w-[420px]">
            <thead>
              <tr className="text-left border-b border-white/10">
                <th className="py-1.5 pr-2 text-[11px] text-slate-500 font-semibold">Metric</th>
                {schemes.map((s) => (
                  <th key={s.id} className="py-1.5 pr-2">
                    <div className="text-[12px] font-bold text-slate-100">{s.name}</div>
                    <div className="flex gap-1.5 mt-1">
                      <button onClick={() => apply(s)} className="text-[10px] px-2 py-0.5 rounded-full bg-teal-400 text-[#0b1526] font-bold">Load →</button>
                      <button onClick={() => remove(s)} className="text-[10px] px-2 py-0.5 rounded-full bg-white/10 hover:bg-white/20 text-slate-300">✕</button>
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {metric('Risk', (s) => s.result?.risk_score ?? '—', (v) => v === '—' ? v : Number(v).toFixed(1))}
              {metric('Level', (s) => s.result?.risk_level ?? levelOf(s.result?.risk_score) ?? '—')}
              {metric('Resilience', (s) => s.result?.resilience_score ?? '—')}
              {metric('Badge', (s) => s.result?.badge ?? '—')}
              {metric('Red flags', (s) => s.result?.flag_count ?? '—')}
              {metric('Footprint m²', (s) => s.input?.footprint_sqm ?? '—')}
              {metric('Plinth m', (s) => s.input?.plinth_m ?? '—')}
              {metric('Permeable m²', (s) => s.input?.permeable_sqm ?? '—')}
              {metric('Storage m³', (s) => s.input?.storage_m3 ?? '—')}
              {metric('Basement lvls', (s) => s.input?.basement_levels ?? 0)}
            </tbody>
          </table>
          <div className="text-[11px] text-slate-400 mt-1.5">
            {schemes.map((s) => (
              <span key={s.id} className="mr-3">
                <b>{s.name}</b>
                {s.result?.risk_score === bestRisk && <span className="text-emerald-300"> · lowest risk ✓</span>}
                {s.result?.resilience_score === bestRes && <span className="text-teal-300"> · top resilience ✓</span>}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
