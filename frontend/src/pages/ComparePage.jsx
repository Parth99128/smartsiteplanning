import { Suspense, lazy, useEffect, useRef, useState } from 'react'
import { BarChart, Bar, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer } from 'recharts'
import { Badge } from '../components/Bits'
import { Skeleton, PageHeader, ErrorBanner, Empty } from '../components/ui'
import { useStore } from '../store'
import { levelOf, toCSV, download } from '../lib/risk'

const CompareTwins = lazy(() => import('../three/Compare3D'))

export default function ComparePage() {
  const { projects, set, clearError, compare } = useStore()
  const err = useStore((s) => s.err)
  const [ids, setIds] = useState([])
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(false)
  const seq = useRef(0)

  // Default selection follows the real project list — never hardcoded ids.
  useEffect(() => {
    if (projects.length && !ids.length) {
      const pick = projects.slice(0, 3).map((p) => p.id)
      setIds(pick)
      if (pick.length >= 2) load(pick)
    }
    // eslint-disable-next-line
  }, [projects.length])

  const load = async (pick) => {
    const use = pick || ids
    if (use.length < 2) { set({ toast: { msg: 'Pick at least 2 projects', kind: 'warn' } }); return }
    const my = ++seq.current
    setLoading(true)
    try {
      const data = await compare(use)
      if (seq.current === my) setRows(data) // ignore stale responses from rapid toggling
    } catch { /* err in store */ }
    if (seq.current === my) setLoading(false)
  }

  const toggle = (id) => {
    const next = ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id].slice(0, 6)
    setIds(next)
    if (next.length >= 2) load(next)
    else setRows([])
  }

  const riskOf = (d) => d.last_simulation?.risk_score ?? d.last_analysis?.risk_score ?? d.last_analysis?.risk?.risk_score ?? 0
  const resOf = (d) => d.last_simulation?.resilience_score ?? d.last_analysis?.resilience_score ?? null
  const badgeOf = (d) => d.last_simulation?.badge ?? d.last_analysis?.badge ?? 'Bronze'
  const nameOf = (d) => (d.project || d).name || `Project ${(d.project || d).id}`

  const table = rows.map((d) => {
    const p = d.project || d
    const a = d.last_analysis || {}
    const simTop = d.last_simulation?.top_factors || []
    const aTop = a.top_factors || a.risk?.top_factors || []
    const topList = Array.isArray(aTop) ? aTop : Array.isArray(simTop) ? simTop : []
    const flagList = Array.isArray(a.flags) ? a.flags : []
    return {
      id: p.id, name: p.name,
      risk: riskOf(d),
      level: a.risk_level || a.risk?.risk_level || d.last_simulation?.risk_level || levelOf(riskOf(d)),
      res: resOf(d), badge: badgeOf(d),
      top: (topList.length ? topList : simTop).join(', ') || '—',
      flags: flagList.length,
      heightmap: d.heightmap || {},
    }
  })
  const chart = table.map((t) => ({
    name: t.name.split(' ').slice(0, 2).join(' '),
    risk: Number(Number(t.risk).toFixed(1)),
    resilience: t.res ? Number(Number(t.res).toFixed(1)) : 0,
  }))
  const winner = table.length ? table.reduce((a, b) => (a.risk <= b.risk ? a : b)) : null

  if (!projects.length) {
    return (
      <div className="px-4 sm:px-6 pt-10 max-w-xl mx-auto">
        <Empty icon="▦" title="No projects to compare" hint="Create at least 2 projects from the sidebar first." />
      </div>
    )
  }

  return (
    <div className="px-4 sm:px-6 pt-5 pb-10 space-y-4 max-w-[1400px] mx-auto">
      <PageHeader eyebrow="Site selection" title="Multi-Site Comparison" sub="Analyze projects side by side — 3D twins render stored terrain"
        actions={
          <>
            {projects.slice(0, 6).map((p) => (
              <button key={p.id} onClick={() => toggle(p.id)}
                className={`text-xs px-3 py-1.5 rounded-full font-bold ${ids.includes(p.id) ? 'bg-teal-400 text-[#0b1526]' : 'bg-white/10 hover:bg-white/20'}`}>
                {ids.includes(p.id) ? '✓ ' : ''}{p.name.split(' ').slice(0, 2).join(' ')}
              </button>
            ))}
            <button disabled={!table.length}
              onClick={() => download('floodshield-compare.csv', toCSV(table.map((t) => ({ plot: t.name, risk: t.risk, level: t.level, resilience: t.res ?? '', badge: t.badge, top_factors: t.top })) ), 'text/csv')}
              className="text-xs bg-white/10 hover:bg-white/20 px-3 py-1.5 rounded-full font-bold disabled:opacity-40">⬇ CSV</button>
          </>
        } />

      {err && <ErrorBanner message={err} onRetry={() => load()} onDismiss={clearError} />}
      {loading && <span className="text-xs text-slate-400">⏳ analyzing…</span>}

      {loading && !rows.length ? (
        <div className="grid md:grid-cols-3 gap-4"><Skeleton /><Skeleton /><Skeleton /></div>
      ) : !rows.length ? (
        <Empty title="Nothing compared yet" hint="Pick at least 2 projects above. Each one is analyzed on demand." />
      ) : (
        <>
          <div className="grid md:grid-cols-3 gap-4">
            {table.map((t) => (
              <div key={t.id} className={`glass card-hover p-5 ${winner && t.id === winner.id ? 'ring-2 ring-emerald-400/60' : ''}`}>
                <div className="flex items-center justify-between">
                  <div className="font-bold">{t.name}</div>
                  {winner && t.id === winner.id && <span className="text-[11px] font-bold bg-emerald-500/20 text-emerald-300 px-2 py-0.5 rounded-full">★ lowest risk</span>}
                </div>
                <div className={`font-num text-4xl font-bold mt-2 ${t.risk > 60 ? 'text-red-400' : 'text-emerald-300'}`}>{Number(t.risk).toFixed(1)}</div>
                <div className="text-xs text-slate-400">risk · {t.level} · {t.flags ? `🚩 ${t.flags}` : '✓ no flags'}</div>
                <div className="mt-2"><Badge level={t.badge} /></div>
                <div className="text-xs text-slate-400 mt-2">Resilience: <b className="font-num text-teal-300">{t.res != null ? Number(t.res).toFixed(1) : '—'}</b></div>
                <div className="text-[11px] text-slate-500 mt-1">Top: {t.top}</div>
              </div>
            ))}
          </div>

          <div className="glass p-5">
            <div className="font-bold mb-1">3D twins <span className="text-[11px] text-slate-400 font-normal">stored terrain · water scaled by risk</span></div>
            <Suspense fallback={<Skeleton className="h-[220px]" />}>
              <CompareTwins items={table} />
            </Suspense>
          </div>

          <div className="glass p-5">
            <div className="font-bold mb-2">Risk vs Resilience</div>
            <div className="h-64"><ResponsiveContainer><BarChart data={chart}>
              <XAxis dataKey="name" tick={{ fill: '#94a3b8', fontSize: 12 }} />
              <YAxis domain={[0, 100]} tick={{ fill: '#94a3b8', fontSize: 11 }} />
              <Tooltip /><Legend />
              <Bar dataKey="risk" fill="#f87171" radius={6} name="Flood risk" />
              <Bar dataKey="resilience" fill="#2dd4bf" radius={6} name="Resilience" />
            </BarChart></ResponsiveContainer></div>
          </div>

          <div className="glass p-5 overflow-auto">
            <div className="font-bold mb-2">Detail table</div>
            <table className="w-full text-xs">
              <thead><tr className="text-left text-slate-400 border-b border-white/10">
                <th className="py-2 pr-3">Project</th><th className="pr-3">Risk</th><th className="pr-3">Level</th>
                <th className="pr-3">Resilience</th><th className="pr-3">Badge</th><th>Top factors</th>
              </tr></thead>
              <tbody>
                {table.map((t) => (
                  <tr key={t.id} className="border-b border-white/5">
                    <td className="py-2 pr-3 font-bold">{t.name}</td>
                    <td className="pr-3 font-num">{Number(t.risk).toFixed(1)}</td>
                    <td className="pr-3">{t.level}</td>
                    <td className="pr-3 font-num">{t.res != null ? Number(t.res).toFixed(1) : '—'}</td>
                    <td className="pr-3">{t.badge}</td>
                    <td className="text-slate-400">{t.top}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}
