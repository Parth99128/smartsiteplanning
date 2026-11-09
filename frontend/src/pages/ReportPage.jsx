import { useEffect, useState } from 'react'
import jsPDF from 'jspdf'
import { apiGet } from '../lib/api'
import { useStore } from '../store'
import { Badge } from '../components/Bits'
import { PageHeader } from '../components/ui'
import RedFlags, { FactorTable, BreakdownTable } from '../components/RedFlags'
import Compliance from '../components/Compliance'
import BOQ from '../components/BOQ'
import { buildCompliance } from '../lib/compliance'
import { buildBOQ, loadRates } from '../lib/boq'
import { buildSummary, download, effectiveRiseM, levelOf } from '../lib/risk'

export default function ReportPage() {
  const { activeId, projects, analysis, simulation, climate, scenario, simInputs, set } = useStore()
  const loadAssets = useStore((s) => s.loadAssets)
  const [assets, setAssets] = useState([])
  const loadZones = useStore((s) => s.loadZones)
  const loadConflicts = useStore((s) => s.loadConflicts)
  const [share, setShare] = useState(null)
  const [pub, setPub] = useState(null)
  const [busy, setBusy] = useState(false)
  const [zones, setZones] = useState([])
  const [conflicts, setConflicts] = useState([])

  const project = projects.find((p) => p.id === activeId)
  const risk = simulation?.risk_score ?? analysis?.risk?.risk_score
  const level = simulation?.risk_level ?? analysis?.risk?.risk_level ?? (risk != null ? levelOf(risk) : null)
  const res = simulation?.resilience_score ?? analysis?.resilience_score
  const badge = simulation?.badge ?? analysis?.badge
  const breakdown = simulation?.resilience_breakdown ?? analysis?.resilience_breakdown
  const flags = simulation?.red_flags?.length ? simulation.red_flags : (analysis?.red_flags || [])
  const ratings = simulation?.factor_ratings?.length ? simulation.factor_ratings : (analysis?.factor_ratings || [])
  const downstream = simulation?.downstream || null
  const recs = analysis?.recommendations || []
  const hm = simulation?.heightmap || analysis?.heightmap
  const topF = simulation?.top_factors || analysis?.risk?.top_factors || []
  const rise = effectiveRiseM(climate, scenario)

  const boqDesign = {
    ...simInputs,
    green_sqm: project?.green_sqm ?? 400,
    footprint_sqm: project?.footprint_sqm ?? simInputs.footprint_sqm,
    recharge_pits: assets.filter((a) => a.kind === 'recharge_pit').length || undefined,
    storage_m3: assets.some((a) => a.kind === 'sump')
      ? assets.filter((a) => a.kind === 'sump').reduce((s, a) => s + (Number(a.capacity_m3) || 0), 0)
      : simInputs.storage_m3,
  }

  useEffect(() => {
    if (activeId == null) return
    loadZones().then(setZones).catch(() => {})
    loadConflicts().then((c) => setConflicts(c.conflicts || [])).catch(() => {})
    loadAssets().then((a) => setAssets(Array.isArray(a) ? a : [])).catch(() => {})
  }, [activeId]) // eslint-disable-line

  const summary = buildSummary({ risk, level, res, badge, topF, recCount: recs.length, climate, scenario, flagCount: flags.length })

  if (!projects.length || activeId == null) {
    return (
      <div className="px-6 pt-10 max-w-xl mx-auto">
        <div className="glass p-8 text-center">
          <div className="text-3xl">📄</div>
          <div className="font-extrabold text-lg mt-2">No report yet</div>
          <p className="text-sm text-slate-400 mt-1">Create a project and run Analyze on the Dashboard first — the report builds itself from stored model output.</p>
        </div>
      </div>
    )
  }

  const generate = async () => {
    setBusy(true)
    try {
      const data = await useStore.getState().makeReport()
      setShare(data)
      set({ toast: 'Report ready · share: ' + data.share_url })
    } catch { set({ toast: 'Backend offline' }) }
    setBusy(false)
  }

  const openPublic = async () => {
    if (!share) return
    try {
      const r = await apiGet(`/public/${share.share_token}`)
      setPub(r.data)
    } catch { set({ toast: 'Public link failed' }) }
  }

  const exportPDF = () => {
    const d = new jsPDF()
    d.setFontSize(18); d.text('FloodShield AI — Project Report', 10, 15)
    d.setFontSize(11)
    d.text(`Project: ${project?.name || `Project ${activeId}`}`, 10, 23)
    d.text(`Risk: ${risk ?? '-'} (${level ?? '-'})   Resilience: ${res ?? '-'} (${badge ?? '-'})   Climate +${climate}%`, 10, 30)
    const lines = d.splitTextToSize(`Summary: ${summary}`, 190)
    d.text(lines, 10, 37)
    d.text('Interventions:', 10, 37 + lines.length * 6)
    recs.slice(0, 5).forEach((r, i) => {
      const t = d.splitTextToSize(`- ${r.action} (${r.cost_band}, +${r.gain_pts} pts)`, 186)
      d.text(t, 12, 44 + lines.length * 6 + i * 12)
    })
    d.text(`Compliance: ${complianceSheet.verdict} (${complianceSheet.passed} pass, ${complianceSheet.failed} fix, ${complianceSheet.open} open)`, 10, 46 + lines.length * 6 + Math.min(5, recs.length) * 12)
    complianceSheet.checks.filter((c) => c.status === 'fail').slice(0, 4).forEach((c, i) => {
      d.text(d.splitTextToSize(`  x ${c.label}: ${c.measured} vs ${c.required}`, 184), 12, 52 + lines.length * 6 + Math.min(5, recs.length) * 12 + i * 6)
    })
    const failLines = complianceSheet.checks.filter((c) => c.status === 'fail').slice(0, 4).length
    const yImg = 60 + lines.length * 6 + Math.min(5, recs.length) * 12 + failLines * 6
    d.setFontSize(9)
    d.text(`Assumptions: stored terrain ${hm ? `${hm.size}x${hm.size}` : 'n/a'} (${hm?.source || 'surveyed'}), RF model ${simulation?.model_version || 'v1'}, +${rise.toFixed(2)}m forcing. Planning-grade — verify with licensed engineer.`, 10, yImg)
    const c = document.querySelector('#fs3d canvas')
    if (c) { try { d.addImage(c.toDataURL('image/png'), 'PNG', 10, yImg + 5, 190, 95) } catch { /* tainted canvas */ } }
    d.save(`floodshield-report-plot${activeId}.pdf`)
  }

  const complianceSheet = buildCompliance({
    factors: analysis?.features || {},
    design: { ...simInputs, green_sqm: project?.green_sqm ?? 400, footprint_sqm: project?.footprint_sqm ?? simInputs.footprint_sqm },
    siteArea: project?.site_area_sqm, roofSqm: project?.footprint_sqm,
    intersects: hm?.intersects, hyd: simulation?.hydraulics || analysis?.hydraulics,
    basement: { levels: simInputs.basement_levels ?? 0, verdict: simInputs._basementVerdict },
    city: analysis?.site_context?.city,
  })

  const exportJSON = async () => {
    let schemes = []
    try {
      const r = await apiGet(`/projects/${activeId}/schemes`)
      if (Array.isArray(r.data)) schemes = r.data
    } catch { /* report without schemes */ }
    download(`floodshield-report-project${activeId}.json`, JSON.stringify({
      project, risk, level, resilience: res, badge, resilience_breakdown: breakdown,
      red_flags: flags, factor_ratings: ratings, climate_pct: climate,
      downstream, zones, zone_conflicts: conflicts,
      design_schemes: schemes,
      compliance: complianceSheet,
      boq: buildBOQ(
        boqDesign,
        { pumpLps: simInputs.basement_pump_lps, standby: simInputs.basement_standby }, loadRates()),
      site_assets: assets,
      water_rise_m: rise, top_factors: topF, recommendations: recs,
      heightmap_meta: hm ? { size: hm.size, cell_m: hm.cell_m, intersects: hm.intersects, outlet: hm.outlet, flow_points: hm.flow_path?.length, source: hm.source } : null,
      summary, disclaimer: 'Planning-grade estimate. Verify with a licensed engineer.',
    }, null, 2), 'application/json')
  }

  return (
    <div className="px-6 pt-5 pb-10 max-w-4xl mx-auto space-y-4">
      <PageHeader eyebrow="Deliverable" title="Project Report" sub={project ? `${project.name} · read the summary, verify assumptions, then share` : 'Read the summary, verify assumptions, then share'} />

      <div className="glass p-5 grid grid-cols-3 gap-4 text-center">
        <div><div className="text-xs text-slate-400">FLOOD RISK</div><div className="font-num text-3xl font-bold text-red-300">{risk != null ? Number(risk).toFixed(1) : '—'}</div><div className="text-[11px] text-slate-500">{level || ''}</div></div>
        <div><div className="text-xs text-slate-400">RESILIENCE</div><div className="font-num text-3xl font-bold text-teal-300">{res ?? '—'}</div></div>
        <div className="flex flex-col items-center justify-center gap-1"><Badge level={badge || 'Bronze'} /><span className="text-[11px] text-slate-400">climate +{climate}% · +{rise.toFixed(2)}m</span></div>
      </div>

      <div className="glass p-5 text-sm">
        <div className="font-bold mb-1">Executive summary <span className="text-[11px] font-normal text-slate-400">auto-generated from model output</span></div>
        <p className="text-slate-300 leading-relaxed">{analysis || simulation ? summary : 'Run Analyze on the Dashboard first — the summary writes itself from risk drivers and interventions.'}</p>
      </div>

      <div className="glass p-5 text-sm space-y-1">
        <div className="font-bold">Site analysis</div>
        <div className="text-slate-300">Terrain grid: {hm ? `${hm.size}×${hm.size} · ${hm.cell_m}m cells` : '—'} · Flow points: {hm?.flow_path?.length ?? '—'} · Intersects building: {hm ? (hm.intersects ? 'YES ⚠️' : 'no ✓') : '—'}</div>
        <div className="text-slate-300">Top drivers: {topF.join(', ') || '—'}</div>
        <div className="text-slate-300">Scenario forcing: +{climate}% rain · +{Number(scenario.surgeM).toFixed(1)}m surge · {scenario.blockedPct}% drains blocked → +{rise.toFixed(2)}m in twin</div>
      </div>

      <div className="glass p-5 text-sm">
        <div className="font-bold mb-2">Red flags ({flags.length})</div>
        <RedFlags flags={flags} />
      </div>

      <div className="glass p-5 text-sm">
        <div className="font-bold mb-2">No-waterlogging compliance <span className="text-[11px] font-normal text-slate-400">builder sheet</span></div>
        <Compliance
          factors={analysis?.features || {}}
          design={{ ...simInputs, green_sqm: project?.green_sqm ?? 400, footprint_sqm: project?.footprint_sqm ?? simInputs.footprint_sqm }}
          siteArea={project?.site_area_sqm}
          roofSqm={project?.footprint_sqm}
          intersects={hm?.intersects}
          hyd={simulation?.hydraulics || analysis?.hydraulics}
          basement={{ levels: simInputs.basement_levels ?? 0, verdict: simInputs._basementVerdict }}
          city={analysis?.site_context?.city} />
      </div>

      <div className="glass p-5 text-sm">
        <div className="font-bold mb-2">Factor analysis</div>
        <FactorTable ratings={ratings} />
      </div>

      <div className="glass p-5 text-sm">
        <div className="font-bold mb-2">Resilience breakdown</div>
        <BreakdownTable breakdown={breakdown} />
      </div>

      <div className="glass p-5 text-sm">
        <div className="font-bold mb-2">Recommendations ({recs.length})</div>
        {recs.map((r, i) => (
          <div key={i} className="grid grid-cols-[1fr_auto] gap-2 text-slate-300 text-xs py-1.5 border-b border-white/5">
            <span>→ <b>{r.action}</b> — {r.reason} <span className="text-slate-500">({r.priority} · {r.cost_band})</span></span>
            <span className="font-num text-teal-300">+{r.gain_pts} pts</span>
          </div>
        ))}
        {!recs.length && <div className="text-xs text-slate-500">Run Analyze on the Dashboard first.</div>}
      </div>

      <div className="glass p-5 text-sm">
        <div className="font-bold mb-2">BOQ — costed interventions <span className="text-[11px] font-normal text-slate-400">editable PWD-style rates, CSV export{assets.length ? ` · ${assets.length} site assets counted` : ''}</span></div>
        <BOQ
          design={boqDesign}
          basement={{ pumpLps: simInputs.basement_pump_lps, standby: simInputs.basement_standby }} />
      </div>

      <div className="glass p-5 text-sm">
        <div className="font-bold mb-2">Site zones & conflicts ({zones.length} zones, {conflicts.length} conflicts)</div>
        {conflicts.map((c, i) => (
          <div key={i} className="text-xs py-1 border-b border-white/5"><b>{c.severity}</b> — {c.message}</div>
        ))}
        {!conflicts.length && <div className="text-xs text-slate-500">{zones.length ? 'Zones clear the flow path.' : 'No zones tagged (see Site Plan).'}</div>}
        {downstream && <div className="text-xs text-slate-300 mt-2">Downstream: runoff coefficient {downstream.runoff_coefficient}, outlet {downstream.outlet_direction}, ≈{downstream.est_runoff_m3} m³ design-storm discharge.</div>}
      </div>

      <div className="glass p-5 text-xs text-slate-400">
        <div className="font-bold text-slate-200">Technical assumptions & limitations</div>
        Stored 12-factor site record + Random-Forest v2 risk model + gradient-descent flow path over the stored terrain grid. Scenario forcing is recorded per run. Outputs are planning-grade estimates for design discussion — verify with a licensed engineer; not a construction approval.
      </div>

      <div className="flex gap-2 flex-wrap">
        <button onClick={generate} disabled={busy} className="bg-teal-400 text-[#0b1526] px-4 py-2 rounded-xl font-bold text-sm disabled:opacity-50">
          {busy ? 'Working…' : 'Generate report + share link'}
        </button>
        <button onClick={exportPDF} className="bg-white/10 hover:bg-white/20 px-4 py-2 rounded-xl text-sm">📄 Export PDF (incl. 3D snapshot)</button>
        <button onClick={exportJSON} className="bg-white/10 hover:bg-white/20 px-4 py-2 rounded-xl text-sm">⬇ JSON</button>
        {share && <button onClick={openPublic} className="bg-white/10 hover:bg-white/20 px-4 py-2 rounded-xl text-sm">👁 Preview public link</button>}
      </div>

      {share && (
        <div className="glass p-4 text-sm">
          <div className="font-bold">🔗 Shareable read-only link</div>
          <code className="text-teal-300 text-xs">{share.share_url}</code>
          <span className="text-slate-400 text-xs"> · token <code>{share.share_token}</code> · <a className="underline" href={`/r/${share.share_token}`}>open /r/{share.share_token}</a></span>
        </div>
      )}
      {pub && <div className="glass p-4 text-sm"><div className="font-bold">Public preview (read-only ✓)</div><div className="text-slate-300">{pub.project?.name}</div></div>}
    </div>
  )
}
