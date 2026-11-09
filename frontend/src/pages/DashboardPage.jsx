import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'
import { motion } from 'framer-motion'
import MapView from '../components/MapView'
import CreateProjectWizard from '../components/CreateProjectWizard'
import Simulator from '../components/Simulator'
import Advisory from '../components/Advisory'
import ScenarioBar from '../components/ScenarioBar'
import { RiskCard, BadgePro, RiskGauge, Delta } from '../components/Bits'
import RedFlags, { FactorTable, BreakdownTable } from '../components/RedFlags'
import Compliance from '../components/Compliance'
import DrainDesigner from '../components/DrainDesigner'
import Schemes from '../components/Schemes'
import LiveSky from '../components/LiveSky'
import { Btn, Skeleton, Empty, ErrorBanner } from '../components/ui'
import { useStore } from '../store'
import { effectiveRiseM, levelOf } from '../lib/risk'
import { fetchRealGrid } from '../lib/terrain'
import { fetchSiteContext } from '../lib/siteContext'
import { apiGet, apiPut } from '../lib/api'

// Lazy 3D: Three.js loads only when this view renders, keeping first paint fast
const Terrain3D = lazy(() => import('../three/Terrain3D'))

/* Heuristic: map a recommendation onto simulator inputs. */
function patchFor(rec) {
  const t = `${rec.problem || ''} ${rec.action || ''}`.toLowerCase()
  if (t.includes('impervious')) return { permeable_sqm: 800, rain_garden: true }
  if (t.includes('block') || t.includes('corridor')) return { storage_m3: 60, recharge: true }
  if (t.includes('plinth')) return { plinth_m: 0.9 }
  if (t.includes('drainage') || t.includes('storage')) return { storage_m3: 60, recharge: true }
  return { rain_garden: true, permeable_sqm: 600 }
}

export default function DashboardPage() {
  const {
    activeId, projects, analysis, simulation, dusk, climate,
    loading, err, simInputs, scenario, history, set, clearError, analyze, simulate, updateSite,
  } = useStore()
  const [show3D, setShow3D] = useState(true)
  const [showNew, setShowNew] = useState(false)
  const [site, setSite] = useState({ lat: 23.082, lng: 72.493 })
  const [applied, setApplied] = useState({})
  const [applyResult, setApplyResult] = useState(null)
  const [applying, setApplying] = useState(false)
  const applyAll = useStore((s) => s.applyAll)
  const loadZones = useStore((s) => s.loadZones)
  const [zones3d, setZones3d] = useState([])
  const [ctx, setCtx] = useState(null)
  const [placement, setPlacement] = useState({ cx: 0.475, cy: 0.475 })
  const moveTimer = useRef(null)
  const ctxTimer = useRef(null)
  const placeTimer = useRef(null)
  useEffect(() => () => { clearTimeout(moveTimer.current); clearTimeout(ctxTimer.current); clearTimeout(placeTimer.current) }, [])

  // Proposed-block placement follows the active project.
  useEffect(() => {
    setPlacement({ cx: 0.475, cy: 0.475 })
    if (activeId == null) return
    apiGet(`/projects/${activeId}/placement`)
      .then((r) => {
        if (Number.isFinite(r.data?.cx) && Number.isFinite(r.data?.cy)) {
          setPlacement({ cx: r.data.cx, cy: r.data.cy })
        }
      })
      .catch(() => {})
  }, [activeId])

  // Municipal drain context for the pin (cached, silent on failure).
  useEffect(() => {
    clearTimeout(ctxTimer.current)
    ctxTimer.current = setTimeout(async () => {
      try {
        const c = await fetchSiteContext(site.lat, site.lng)
        setCtx(c)
      } catch { /* geo-estimate only */ }
    }, 400)
    return () => clearTimeout(ctxTimer.current)
  }, [site.lat, site.lng])

  useEffect(() => {
    setZones3d([])
    if (activeId == null) return
    loadZones().then(setZones3d).catch(() => {})
  }, [activeId]) // eslint-disable-line

  useEffect(() => { setApplied({}) }, [activeId])

  const project = projects.find((p) => p.id === activeId)
  useEffect(() => {
    if (project?.lat != null && project?.lng != null) {
      setSite({ lat: Number(project.lat), lng: Number(project.lng) })
    }
  }, [project?.lat, project?.lng])

  const hm = simulation?.heightmap || analysis?.heightmap
  const risk = simulation?.risk_score ?? analysis?.risk?.risk_score
  const baseRisk = analysis?.risk?.risk_score
  const res = simulation?.resilience_score ?? analysis?.resilience_score
  const badge = simulation?.badge ?? analysis?.badge
  const breakdown = simulation?.resilience_breakdown ?? analysis?.resilience_breakdown
  const flags = simulation?.red_flags?.length ? simulation.red_flags : (analysis?.red_flags || [])
  const ratings = simulation?.factor_ratings?.length ? simulation.factor_ratings : (analysis?.factor_ratings || [])
  const downstream = simulation?.downstream || null
  const recs = analysis?.recommendations || []
  const placements = recs.map((r) => r.placement).filter(Boolean)
  // Registry drains win; fall back to stored analysis context after Analyze.
  const drains = ctx?.drains?.length ? ctx.drains : (analysis?.site_context?.drains || [])
  const inlets = ctx?.inlets?.length ? ctx.inlets : (analysis?.site_context?.inlets || [])
  const hyd = analysis?.hydraulics || null
  const surchargedIds = hyd?.surcharged_ids || []
  const ctxCity = ctx?.city || analysis?.site_context?.city || null
  const ctxConf = ctx?.confidence ?? analysis?.site_context?.confidence ?? null
  const rise = effectiveRiseM(climate, scenario)
  const contribData = Object.entries(simulation?.contributions || analysis?.risk?.contributions || {})
    .map(([k, v]) => ({ k: k.slice(0, 14), v }))
    .sort((a, b) => b.v - a.v)

  const onAnalyze = async () => {
    clearError()
    // Measured terrain first (cached after the first read); synthetic fallback on failure.
    let body = null
    try {
      const t = await fetchRealGrid(site.lat, site.lng)
      body = { elevation_grid: t.grid, cell_m: t.cellM }
      if (!t.cached) set({ toast: { msg: t.source === 'terrarium-30m' ? 'Measured 30m terrain loaded — tracing flow on real elevation.' : 'Measured terrain loaded — tracing flow on real elevation.', kind: 'success' } })
    } catch { /* backend traces the labelled analytical terrain */ }
    analyze(body).catch(() => {})
  }

  // Re-trace flow + risk for the current pin (measured terrain when reachable).
  const reanalyze = async (lat, lng, note) => {
    set({ toast: { msg: note || 'Rebuilding terrain…', kind: 'info' } })
    let body = {}
    try {
      const t = await fetchRealGrid(lat, lng)
      body = { elevation_grid: t.grid, cell_m: t.cellM }
    } catch { /* backend falls back to labelled analytical terrain */ }
    try {
      await analyze(body)
      set({ toast: { msg: 'Terrain + drains + risk rebuilt.', kind: 'success' } })
    } catch { /* analyze surfaces its own error */ }
  }

  const onPickSite = (ll) => {
    setSite({ lat: ll.lat, lng: ll.lng })
    if (activeId == null) return
    // Debounced save + re-analysis: the 3D terrain, drains and risk must follow
    // the pin — otherwise the twin keeps showing the previous location.
    clearTimeout(moveTimer.current)
    moveTimer.current = setTimeout(() => {
      updateSite(activeId, ll.lat, ll.lng)
        .then(() => reanalyze(ll.lat, ll.lng, `Site moved → ${ll.lat.toFixed(4)}, ${ll.lng.toFixed(4)} — rebuilding terrain…`))
        .catch(() => set({ toast: { msg: 'Site move failed to save — retry.', kind: 'error' } }))
    }, 900)
  }

  // Architect drags the proposed block → persist + rebuild flow/risk live.
  const onMoveBuilding = (pos) => {
    setPlacement(pos)
    if (activeId == null) return
    clearTimeout(placeTimer.current)
    placeTimer.current = setTimeout(() => {
      apiPut(`/projects/${activeId}/placement`, pos)
        .then(() => reanalyze(site.lat, site.lng, 'Block moved — re-tracing flow…'))
        .catch(() => set({ toast: { msg: 'Block move failed to save — retry.', kind: 'error' } }))
    }, 900)
  }

  if (!projects.length) {
    return (
      <div className="px-4 sm:px-6 pt-6 pb-10 max-w-5xl mx-auto space-y-4">
        <div className="text-center">
          <div className="eyebrow">Getting started</div>
          <h1 className="h-display text-2xl mt-1">Start with your site</h1>
          <p className="text-sm text-slate-400 mt-1 max-w-xl mx-auto">Click the map — the system detects ground conditions for that spot, then creates the project and runs the full analysis.</p>
        </div>
        {err && <ErrorBanner message={err} onDismiss={clearError} />}
        <CreateProjectWizard />
      </div>
    )
  }

  const applyRec = (r, i) => {
    const patch = patchFor(r)
    setApplied((a) => ({ ...a, [i]: true }))
    simulate(patch).catch(() => setApplied((a) => ({ ...a, [i]: false })))
  }

  const runApplyAll = async (save) => {
    setApplying(true)
    try {
      const r = await applyAll(!save)
      setApplyResult(r)
      if (!save) set({ toast: { msg: `Recommended design: risk ${r.before.risk_score} → ${r.after.risk_score}`, kind: 'success' } })
    } catch { setApplyResult(null) }
    setApplying(false)
  }

  const improvement = applyResult && applyResult.after?.resilience_score != null && res != null
    ? +(applyResult.after.resilience_score - res).toFixed(1) : null

  return (
    <div className="px-4 sm:px-6 pt-5 pb-4 max-w-[1400px] mx-auto">
      {/* hero */}
      <div className="glass-strong p-5 flex flex-wrap items-center gap-3">
        <div className="min-w-0">
          <div className="eyebrow">Site analysis</div>
          <h1 className="h-display text-xl truncate">{project?.name || 'Project'}</h1>
          <div className="flex flex-wrap gap-1.5 mt-1.5">
            <span className="chip-dim">📍 {site.lat.toFixed(4)}, {site.lng.toFixed(4)}</span>
            <span className="chip-info">+{climate}% rain · +{rise.toFixed(2)} m forcing</span>
            {risk != null && <span className="chip-warn">{levelOf(risk)} risk</span>}
            {ctxCity
              ? <span className="chip-info" title={`Municipal drain registry (${ctxCity}) — ${(ctxConf * 100).toFixed(0)}% confidence`}>🌊 {ctxCity} registry · {drains.length} drains{(ctxConf != null) ? ` · ${(ctxConf * 100).toFixed(0)}%` : ''}</span>
              : <span className="chip-dim" title="Outside Chennai / Bengaluru / Pune / Nashik pilot registries — geo-estimate only">geo-estimate</span>}
          </div>
        </div>
        <div className="ml-auto flex gap-2 flex-wrap">
          <Btn variant="primary" onClick={onAnalyze} loading={loading}>
            {loading ? 'Running…' : '▶ Analyze site'}
          </Btn>
          <Btn variant="violet" size="sm" className="!px-4 !py-2 !text-sm" onClick={() => setShowNew(!showNew)}>
            {showNew ? 'Close picker' : '+ New site'}
          </Btn>
          <Btn variant="ghost" onClick={() => set({ dusk: !dusk })}>{dusk ? '☀ Day' : '🌙 Dusk'}</Btn>
        </div>
      </div>

      {err && <div className="pt-3"><ErrorBanner message={err} onRetry={onAnalyze} onDismiss={clearError} /></div>}

      {showNew && (
        <div className="pt-4 animate-fade-up">
          <CreateProjectWizard onCreated={() => setShowNew(false)} />
        </div>
      )}

      {loading && !analysis ? (
        <div className="pt-4 grid grid-cols-2 md:grid-cols-4 gap-4">
          <Skeleton className="h-32" /><Skeleton className="h-32" /><Skeleton className="h-32" /><Skeleton className="h-32" />
        </div>
      ) : (
        <div className="pt-4 grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="glass card-hover p-5"><RiskCard value={risk} climate={climate} /></div>
          <div className="glass card-hover p-5">
            <div className="eyebrow">Resilience (0-100)</div>
            <div className="font-num text-4xl font-bold text-teal-300 mt-1">{res ?? '—'}</div>
            <div className="text-xs text-slate-400 mt-1">green + storage + plinth</div>
          </div>
          <div className="glass card-hover p-5 flex flex-col justify-center gap-2">
            <div className="eyebrow">Badge</div>
            <div><BadgePro level={badge || 'Bronze'} score={res} /></div>
          </div>
          <div className="glass card-hover p-5">
            <div className="eyebrow mb-1">Risk drivers</div>
            <div className="h-24">
              {contribData.length ? (
                <ResponsiveContainer><BarChart data={contribData} layout="vertical">
                  <XAxis type="number" hide /><YAxis type="category" dataKey="k" width={100} tick={{ fill: '#94a3b8', fontSize: 10 }} />
                  <Tooltip contentStyle={{ background: '#0f1e38', border: '1px solid rgba(255,255,255,.12)', borderRadius: 12 }} /><Bar dataKey="v" fill="#22d3ee" radius={6} /></BarChart></ResponsiveContainer>
              ) : <div className="text-[11px] text-slate-500 pt-6">Run analysis to rank drivers.</div>}
            </div>
          </div>
        </div>
      )}

      {simulation && baseRisk != null && (
        <div className="pt-3 flex gap-2 items-center text-xs">
          <span className="text-slate-400">What-if vs baseline:</span>
          <Delta before={baseRisk} after={simulation.risk_score} invert />
          <span className="text-slate-500">risk {baseRisk.toFixed(1)} → {simulation.risk_score.toFixed(1)} ({levelOf(simulation.risk_score)})</span>
        </div>
      )}

      {hyd && hyd.margin_ratio < -0.2 && (
        <div className="pt-4">
          <div className="rounded-2xl border border-red-400/40 bg-red-500/10 p-4 text-xs">
            <b className="text-red-300">⚠ Drains cannot carry this storm (physics check).</b>
            <span className="text-slate-300"> Runoff {hyd.q_runoff_m3s} m³/s vs capacity {hyd.q_capacity_m3s} m³/s
              {' '}· {hyd.surcharged_count}/{hyd.segments} segments surcharged (Manning + rational, planning proxy).
              Risk lifted +6 pts. Verify invert levels with the ULB before construction.</span>
          </div>
        </div>
      )}

      {(analysis || project) && (
        <div className="pt-4">
          <div className="glass p-4">
            <LiveSky lat={site.lat} lng={site.lng}
              designRain={Number(analysis?.features?.rainfall_mm ?? project?.rainfall_mm)} />
          </div>
        </div>
      )}

      {analysis?.shift_guidance?.needed && (
        <div className="pt-4">
          <div className="rounded-2xl border border-amber-400/40 bg-amber-500/[.08] p-4 flex flex-wrap items-center gap-3">
            <div className="text-2xl">🧭</div>
            <div className="flex-1 min-w-[200px]">
              <div className="font-bold text-sm text-amber-200">
                {analysis.shift_guidance.feasible === false
                  ? 'No clear position inside this site'
                  : analysis.shift_guidance.message}
              </div>
              <div className="text-[11px] text-slate-400">
                {analysis.shift_guidance.feasible === false
                  ? analysis.shift_guidance.note
                    : `Nearest clear center (${analysis.shift_guidance.new_cx}, ${analysis.shift_guidance.new_cy}) keeps ≥12 m off the traced flow. One click moves the block and re-scores.`}
              </div>
            </div>
            {analysis.shift_guidance.feasible !== false && (
              <button
                onClick={() => {
                  const g = analysis.shift_guidance
                  const pos = { cx: g.new_cx, cy: g.new_cy }
                  setPlacement(pos)
                  apiPut(`/projects/${activeId}/placement`, pos)
                    .then(() => reanalyze(site.lat, site.lng, `Block shifted ${g.distance_m} m ${g.compass} — re-scoring…`))
                    .catch(() => set({ toast: { msg: 'Shift failed to save — retry.', kind: 'error' } }))
                }}
                className="bg-amber-400 text-[#0b1526] px-4 py-2 rounded-xl font-bold text-sm hover:brightness-110">
                Shift {analysis.shift_guidance.distance_m} m {analysis.shift_guidance.compass} →
              </button>
            )}
          </div>
        </div>
      )}

      {(flags.length > 0 || analysis) && (
        <div className="pt-4">
          <div className="glass p-4">
            <div className="frame-head">
              <div className="frame-title">Construction red flags <span className="frame-sub">· auto-detected from stored analysis</span></div>
              {flags.length > 0 && <span className="chip-bad">🚩 {flags.length}</span>}
            </div>
            <RedFlags flags={flags} />
          </div>
        </div>
      )}

      {analysis && (
        <div className="pt-4">
          <div className="glass p-4">
            <div className="frame-head">
              <div className="frame-title">No-waterlogging compliance <span className="frame-sub">· builder sheet vs planning defaults</span></div>
            </div>
            <Compliance
              factors={analysis?.features || {}}
              design={{ ...simInputs, green_sqm: project?.green_sqm ?? 400, footprint_sqm: project?.footprint_sqm ?? simInputs.footprint_sqm }}
              siteArea={project?.site_area_sqm}
              roofSqm={project?.footprint_sqm}
              intersects={hm?.intersects}
              hyd={analysis?.hydraulics}
              basement={{ levels: simInputs.basement_levels ?? 0, verdict: simInputs._basementVerdict }}
              city={ctxCity} />
          </div>
        </div>
      )}

      <div className="pt-4 grid lg:grid-cols-2 gap-4">
        <div className="frame">
          <div className="frame-head">
            <div className="frame-title">2D Site + drainage <span className="frame-sub">· click to move site (saved)</span></div>
          </div>
          <MapView lat={site.lat} lng={site.lng} flow={hm} onPick={onPickSite} placements={placements} drains={drains} inlets={inlets} building={placement} onMoveBuilding={onMoveBuilding} />
        </div>
        <div className="frame">
          <div className="frame-head">
            <div className="frame-title">3D Digital Twin <span className="frame-sub">· +{rise.toFixed(2)} m forcing · plinth {Number(simInputs.plinth_m).toFixed(2)} m</span></div>
            <button onClick={() => setShow3D(!show3D)} className="text-xs bg-white/10 hover:bg-white/20 px-3 py-1 rounded-full">{show3D ? 'collapse' : 'expand'}</button>
          </div>
          {show3D && (
            <Suspense fallback={<Skeleton className="h-[520px]" />}>
              <Terrain3D heightmap={hm} dusk={dusk} riskScore={risk} waterRise={rise} plinthM={simInputs.plinth_m}
                siteLat={site.lat} siteLng={site.lng} zones={zones3d}
                drains={drains} inlets={inlets} surchargedIds={surchargedIds}
                footprintSqm={project?.footprint_sqm ?? analysis?.features?.footprint_sqm ?? 800}
                greenSqm={project?.green_sqm ?? 400}
                buildingCx={placement.cx} buildingCy={placement.cy}
                siteAreaM2={project?.site_area_sqm} />
            </Suspense>
          )}
        </div>
      </div>

      <div className="pt-4 grid lg:grid-cols-3 gap-4">
        <ScenarioBar />
        <Simulator />
        <Advisory />
      </div>

      {analysis && (
        <div className="pt-4">
          <div className="glass p-4">
            <div className="frame-head">
              <div className="frame-title">Internal drain designer <span className="frame-sub">· size your own storm run for the design storm</span></div>
            </div>
            <DrainDesigner
              roofSqm={project?.footprint_sqm ?? 800}
              pavedSqm={Math.max(0, (project?.site_area_sqm ?? 1200) - (project?.footprint_sqm ?? 800) - (project?.green_sqm ?? 400))} />
          </div>
        </div>
      )}

      {analysis && (
        <div className="pt-4">
          <div className="glass p-4">
            <div className="frame-head">
              <div className="frame-title">Design schemes <span className="frame-sub">· option A/B/C for this site</span></div>
            </div>
            <Schemes />
          </div>
        </div>
      )}

      <div className="pt-4 grid lg:grid-cols-3 gap-4 pb-2">
        <div className="glass p-5 lg:col-span-2">
          <div className="frame-head">
            <div className="frame-title">Interventions <span className="frame-sub">· estimated cost vs gain · dashed zones show placement on the 2D map</span></div>
            <Btn size="sm" variant="violet" loading={applying} disabled={!recs.length || applying} onClick={() => runApplyAll(false)}>
              Apply recommended design
            </Btn>
          </div>
          {applyResult && (
            <div className="mb-3 rounded-2xl border border-teal-400/30 bg-teal-500/[.07] p-4">
              <div className="font-bold text-sm">Before → after {applyResult.dry_run ? <span className="text-[11px] font-normal text-slate-400">(preview — not saved)</span> : <span className="text-[11px] font-normal text-emerald-300">(saved as design)</span>}</div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-2 text-center">
                <div><div className="eyebrow">Risk</div><div className="font-num text-xl font-bold">{applyResult.before.risk_score} → <span className="text-emerald-300">{applyResult.after.risk_score}</span></div></div>
                <div><div className="eyebrow">Resilience</div><div className="font-num text-xl font-bold">{applyResult.before.resilience_score ?? '—'} → <span className="text-teal-300">{applyResult.after.resilience_score}</span></div></div>
                <div><div className="eyebrow">Badge</div><div className="font-bold text-sm mt-1">{applyResult.before.badge} → {applyResult.after.badge}</div></div>
                <div><div className="eyebrow">Changes</div><div className="font-num text-xl font-bold">{applyResult.applied?.length || 0}</div></div>
              </div>
              <div className="flex gap-2 mt-3">
                {applyResult.dry_run && <Btn size="sm" variant="primary" loading={applying} onClick={() => runApplyAll(true)}>Save as design</Btn>}
                <Btn size="sm" variant="ghost" onClick={() => setApplyResult(null)}>Dismiss</Btn>
              </div>
            </div>
          )}
          <div className="space-y-2 max-h-80 overflow-auto pr-1">
            {recs.map((r, i) => (
              <motion.div key={i} initial={{ x: 20, opacity: 0 }} animate={{ x: 0, opacity: 1 }}
                className={`border rounded-xl p-3 text-xs ${applied[i] ? 'bg-emerald-500/10 border-emerald-400/40' : 'bg-white/5 border-white/10 hover:border-white/25'} transition`}>
                <div className="flex items-center justify-between gap-2">
                  <div className="font-bold text-amber-300">{r.priority} · {r.problem}</div>
                  <button onClick={() => applyRec(r, i)} disabled={applied[i] || loading}
                    className={`shrink-0 text-[11px] px-2.5 py-1 rounded-full font-bold ${applied[i] ? 'bg-emerald-500/20 text-emerald-300' : 'bg-teal-400 text-[#0b1526] hover:brightness-110'} disabled:opacity-40`}>
                    {applied[i] ? '✓ Applied' : 'Apply → simulate'}
                  </button>
                </div>
                <div className="text-slate-200 mt-0.5">→ {r.action}</div>
                <div className="text-slate-400">{r.reason} · {r.effect}</div>
                <div className="flex justify-between mt-1"><span>{r.cost_band}</span><span className="font-num text-teal-300">+{r.gain_pts} pts</span></div>
              </motion.div>
            ))}
            {!recs.length && <Empty title="No interventions yet" hint="Run Analyze site to generate recommendations from the ML service." />}
          </div>
        </div>
        <div className="glass p-5">
          <div className="frame-head"><div className="frame-title">Resilience gauge</div></div>
          <div className="grid place-items-center"><RiskGauge value={res} /></div>
          <div className="text-center font-num text-2xl text-teal-300">{res ?? '—'}</div>
          <div className="mt-3">
            <div className="text-xs font-bold text-slate-300 mb-1.5">Parameter breakdown</div>
            <BreakdownTable breakdown={breakdown} improvement={improvement} />
          </div>
          <div className="mt-3">
            <div className="text-xs font-bold text-slate-300 mb-1">Run history</div>
            <div className="space-y-1 max-h-36 overflow-auto">
              {history.map((h, i) => (
                <div key={h.ts + i} className="text-[11px] text-slate-400 flex justify-between border-b border-white/5 py-1">
                  <span>{h.type === 'analyze' ? '🔍 analyze' : '🧪 simulate'} · plot {h.projectId}</span>
                  <span className="font-num">{h.risk != null ? `risk ${Number(h.risk).toFixed(0)}` : ''}{h.res != null ? ` · res ${Number(h.res).toFixed(0)}` : ''}</span>
                </div>
              ))}
              {!history.length && <div className="text-[11px] text-slate-500">No runs yet this session.</div>}
            </div>
          </div>
          <div className="text-[11px] text-slate-500 mt-3">Planning-grade estimates. Verify with a licensed engineer before construction decisions.</div>
        </div>
      </div>

      <div className="pt-4 grid lg:grid-cols-3 gap-4 pb-2">
        <div className="glass p-5 lg:col-span-2">
          <div className="frame-head">
            <div className="frame-title">Factor analysis <span className="frame-sub">· per-factor rating + model weight</span></div>
          </div>
          <FactorTable ratings={ratings} />
        </div>
        <div className="glass p-5">
          <div className="frame-head"><div className="frame-title">Downstream impact</div></div>
          {downstream ? (
            <div className="space-y-2 text-xs">
              <div className="flex justify-between"><span className="text-slate-400">Runoff coefficient</span><b className="font-num">{downstream.runoff_coefficient}</b></div>
              <div className="flex justify-between"><span className="text-slate-400">Outlet direction</span><b>{downstream.outlet_direction}</b></div>
              <div className="flex justify-between"><span className="text-slate-400">Est. runoff volume</span><b className="font-num">{downstream.est_runoff_m3} m³</b></div>
              <p className="text-slate-400 leading-relaxed">{downstream.note}</p>
            </div>
          ) : (
            <div className="text-xs text-slate-500">Run a what-if simulation to estimate downstream discharge.</div>
          )}
        </div>
      </div>

      <div className="h-8" />
    </div>
  )
}
