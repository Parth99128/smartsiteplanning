import { useState } from 'react'
import { apiPost } from '../lib/api'
import { useStore } from '../store'

const CHIPS = [
  'Why is my risk score this high?',
  'What gives the fastest badge upgrade?',
  'Will +25% rain flood the plinth?',
  'Which intervention is cheapest per point?',
]

/* Explainable advisory grounded on stored model output: history + chips + copy. */
export default function Advisory() {
  const { activeId, analysis, simulation, notify } = useStore()
  const [q, setQ] = useState(CHIPS[0])
  const [log, setLog] = useState([])
  const [busy, setBusy] = useState(false)

  const ask = async (question) => {
    const query = (question ?? q).trim()
    if (!query || busy) return
    setBusy(true)
    try {
      const r = await apiPost('/advisory', { project_id: activeId, question: query })
      setLog((l) => [{ q: query, a: r.data.answer, ts: Date.now() }, ...l].slice(0, 6))
    } catch {
      notify('Advisory offline — check backend :8080')
    }
    setBusy(false)
  }

  const copy = (t) => {
    try { navigator.clipboard.writeText(t); notify('Copied to clipboard') } catch { /* noop */ }
  }

  const contribs = simulation?.contributions || analysis?.risk?.contributions || {}

  return (
    <div className="glass p-5 space-y-3">
      <div className="font-bold">Explainable AI Advisory <span className="text-[11px] text-slate-400 font-normal">grounded on model output</span></div>
      <div className="flex flex-wrap gap-1">
        {Object.entries(contribs).slice(0, 6).map(([k, v]) => (
          <span key={k} className="text-[11px] bg-cyan-500/15 border border-cyan-400/30 px-2 py-1 rounded-full">{k}: <b className="font-num">{v}</b></span>
        ))}
        {!Object.keys(contribs).length && <span className="text-[11px] text-slate-500">Run Analyze to ground answers in model output.</span>}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {CHIPS.map((c) => (
          <button key={c} onClick={() => { setQ(c); ask(c) }}
            className="text-[11px] bg-white/5 hover:bg-white/10 border border-white/10 px-2.5 py-1 rounded-full text-slate-300 text-left">{c}</button>
        ))}
      </div>
      <div className="flex gap-2">
        <input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && ask()}
          placeholder="Ask about drivers, plinth, costs…" className="flex-1 bg-white/10 rounded-xl px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-teal-400/50" />
        <button onClick={() => ask()} disabled={busy} className="bg-teal-400 text-[#0b1526] px-4 rounded-xl font-bold text-sm disabled:opacity-40">
          {busy ? '…' : 'Ask'}
        </button>
      </div>
      <div className="space-y-2 max-h-56 overflow-auto">
        {log.map((e, i) => (
          <div key={e.ts + i} className="text-sm bg-white/5 border border-white/10 p-3 rounded-xl">
            <div className="text-xs font-bold text-cyan-300">Q: {e.q}</div>
            <div className="text-slate-200 text-xs mt-1">{e.a}</div>
            <button onClick={() => copy(e.a)} className="text-[11px] text-slate-400 hover:text-slate-200 mt-1 underline">copy answer</button>
          </div>
        ))}
      </div>
      <div className="text-[11px] text-slate-500">Planning-grade estimate — verify with a licensed engineer.</div>
    </div>
  )
}
