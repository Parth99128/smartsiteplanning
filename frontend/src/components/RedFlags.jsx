const SEV = {
  Critical: 'bg-red-500/15 border-red-400/50 text-red-200',
  High: 'bg-orange-500/10 border-orange-400/40 text-orange-200',
  Medium: 'bg-amber-500/10 border-amber-400/30 text-amber-200',
  Low: 'bg-white/5 border-white/15 text-slate-300',
  Info: 'bg-cyan-500/10 border-cyan-400/30 text-cyan-200',
}

const DOT = {
  Critical: 'bg-red-400 shadow-[0_0_8px_#ef4444]',
  High: 'bg-orange-400 shadow-[0_0_8px_#fb923c]',
  Medium: 'bg-amber-300 shadow-[0_0_8px_#fbbf24]',
  Low: 'bg-slate-400',
  Info: 'bg-cyan-300 shadow-[0_0_8px_#22d3ee]',
}

/* Construction red flags: deterministic findings from stored analysis. */
export default function RedFlags({ flags = [] }) {
  if (!flags.length) {
    return (
      <div className="flex items-center gap-2 text-xs text-emerald-300 bg-emerald-500/10 border border-emerald-400/30 rounded-xl px-3 py-2.5">
        <span className="font-bold">✓</span> No red flags — no blocking findings for this design.
      </div>
    )
  }
  const order = { Critical: 0, High: 1, Medium: 2, Low: 3, Info: 4 }
  const sorted = [...flags].sort((a, b) => (order[a.severity] ?? 5) - (order[b.severity] ?? 5))
  return (
    <div className="space-y-1.5">
      {sorted.map((f, i) => (
        <div key={i} className={`flex items-start gap-2.5 text-xs border rounded-xl px-3 py-2 ${SEV[f.severity] || SEV.Info}`}>
          <span className={`w-2 h-2 rounded-full mt-1 shrink-0 ${DOT[f.severity] || DOT.Info}`} />
          <div className="min-w-0">
            <span className="font-extrabold tracking-wide">{f.severity?.toUpperCase()} · {f.code?.replace(/_/g, ' ')}</span>
            <div className="opacity-90 mt-0.5">{f.message}</div>
          </div>
        </div>
      ))}
    </div>
  )
}

const RATING_CHIP = {
  High: 'chip-bad', Moderate: 'chip-warn', Low: 'chip-ok',
}

/* Per-factor analysis table: value + rating + model contribution. */
export function FactorTable({ ratings = [] }) {
  if (!ratings.length) return <div className="text-xs text-slate-500">Run analysis to rate each factor.</div>
  return (
    <div className="overflow-auto">
      <table className="w-full text-xs">
        <thead><tr className="text-left text-slate-400 border-b border-white/10">
          <th className="py-1.5 pr-2 font-semibold">Factor</th>
          <th className="pr-2 font-semibold text-right">Value</th>
          <th className="pr-2 font-semibold">Rating</th>
          <th className="font-semibold text-right">Model wt.</th>
        </tr></thead>
        <tbody>
          {ratings.map((r) => (
            <tr key={r.factor} className="border-b border-white/5">
              <td className="py-1.5 pr-2 text-slate-200">{r.label}</td>
              <td className="pr-2 text-right font-num">{typeof r.value === 'number' ? r.value : '—'}</td>
              <td className="pr-2"><span className={RATING_CHIP[r.rating] || 'chip-dim'}>{r.rating}</span></td>
              <td className="text-right font-num text-slate-400">{r.contribution != null ? Number(r.contribution).toFixed(2) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

const PART_LABEL = {
  site_selection: 'Site selection', drainage: 'Drainage', water_storage: 'Water storage',
  permeability: 'Permeability', building_elevation: 'Building elevation', green_infrastructure: 'Green infrastructure',
}

/* Resilience parameter breakdown with improvement projection. */
export function BreakdownTable({ breakdown, improvement }) {
  if (!breakdown) return <div className="text-xs text-slate-500">Run analysis for the parameter breakdown.</div>
  const keys = Object.keys(PART_LABEL).filter((k) => breakdown[k] != null)
  return (
    <div className="space-y-1.5">
      {keys.map((k) => (
        <div key={k}>
          <div className="flex justify-between text-[11px] mb-0.5">
            <span className="text-slate-300">{PART_LABEL[k]}</span>
            <b className="font-num text-teal-200">{Number(breakdown[k]).toFixed(0)}</b>
          </div>
          <div className="h-1.5 bg-white/10 rounded-full overflow-hidden">
            <div className="h-full bg-gradient-to-r from-teal-500 to-cyan-300 rounded-full transition-all" style={{ width: `${Math.min(100, Number(breakdown[k]))}%` }} />
          </div>
        </div>
      ))}
      {improvement != null && improvement > 0 && (
        <div className="text-[11px] font-bold text-emerald-300 bg-emerald-500/10 border border-emerald-400/30 rounded-lg px-2.5 py-1.5 mt-2">
          Potential improvement: +{improvement.toFixed(1)} points after applying all recommendations.
        </div>
      )}
    </div>
  )
}
