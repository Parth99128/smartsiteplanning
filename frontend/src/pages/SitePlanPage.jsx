import { useEffect, useMemo, useRef, useState } from 'react'
import html2canvas from 'html2canvas'
import MapView from '../components/MapView'
import { Btn, Card, Empty, ErrorBanner, PageHeader } from '../components/ui'
import { useStore } from '../store'
import { serverMessage } from '../lib/api'
import { zoneAreas, syncSuggestions, envelopeBounds, envelopeBreaches, parkingCheck } from '../lib/zones'

const KINDS = ['building', 'parking', 'road', 'open_space', 'drainage', 'green']
const ASSET_KINDS = ['recharge_pit', 'sump', 'pump']
const ASSET_LABEL = { recharge_pit: 'Recharge pit', sump: 'Storage sump', pump: 'Pump' }

const SEV_CHIP = {
  Critical: 'chip-bad', High: 'chip-bad', Low: 'chip-warn', Info: 'chip-info',
}

/* Site-plan workspace: tag zones on the map, auto-check them against the
   traced flow path, and overlay uploaded plan images aligned to the site extent. */
export default function SitePlanPage() {
  const { activeId, projects, analysis, simulation } = useStore()
  const loadZones = useStore((s) => s.loadZones)
  const addZone = useStore((s) => s.addZone)
  const deleteZone = useStore((s) => s.deleteZone)
  const loadConflicts = useStore((s) => s.loadConflicts)
  const loadPlans = useStore((s) => s.loadPlans)
  const uploadPlan = useStore((s) => s.uploadPlan)
  const deletePlan = useStore((s) => s.deletePlan)
  const loadAssets = useStore((s) => s.loadAssets)
  const addAsset = useStore((s) => s.addAsset)
  const deleteAsset = useStore((s) => s.deleteAsset)

  const project = projects.find((p) => p.id === activeId)
  const hm = simulation?.heightmap || analysis?.heightmap
  const site = {
    lat: Number(project?.lat ?? 23.082),
    lng: Number(project?.lng ?? 72.493),
  }
  const { set, notify } = useStore()
  const simInputs = useStore((s) => s.simInputs)
  const [zones, setZones] = useState([])
  const [assets, setAssets] = useState([])
  const [assetKind, setAssetKind] = useState('recharge_pit')
  const [assetCap, setAssetCap] = useState(20)
  const [conflicts, setConflicts] = useState([])
  const [plans, setPlans] = useState([])
  const [kind, setKind] = useState('building')
  const [zname, setZname] = useState('')
  const [drawing, setDrawing] = useState(false)
  const [drawMode, setDrawMode] = useState('rect') // rect | poly
  const [corner, setCorner] = useState(null)
  const [vertices, setVertices] = useState([])
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  const areas = useMemo(() => zoneAreas(zones), [zones])
  const areaById = useMemo(() => Object.fromEntries(areas.per.map((z) => [z.id, z.area_m2])), [areas])
  const suggestions = useMemo(() => syncSuggestions(areas.byKind), [areas])
  const [sb, setSb] = useState({ front: 3, side: 3, rear: 3 })
  const [parkPer100, setParkPer100] = useState(1)
  const [exportBusy, setExportBusy] = useState(false)
  const mapWrapRef = useRef(null)
  const env = useMemo(() => envelopeBounds(site.lat, site.lng, sb), [site.lat, site.lng, sb])
  const breaches = useMemo(() => envelopeBreaches(zones, env), [zones, env])
  const parking = useMemo(
    () => parkingCheck(areas.byKind.parking || 0, project?.footprint_sqm ?? 0, parkPer100),
    [areas, project?.footprint_sqm, parkPer100])

  const autoDrain = async () => {
    const fp = hm?.flow_path || []
    if (fp.length < 2) { setErr('Run Analyze first — auto-drainage needs the traced flow path.'); return }
    let x0 = 1, y0 = 1, x1 = 0, y1 = 0
    fp.forEach((p) => { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y) })
    const pad = 0.04
    const gx = (nx) => site.lng - 0.005 + nx * 0.01
    const gy = (ny) => site.lat - 0.005 + ny * 0.01
    const cx0 = Math.max(0, x0 - pad), cy0 = Math.max(0, y0 - pad)
    const cx1 = Math.min(1, x1 + pad), cy1 = Math.min(1, y1 + pad)
    const spine = [
      { lat: gy(cy0), lng: gx(cx0) }, { lat: gy(cy0), lng: gx(cx1) },
      { lat: gy(cy1), lng: gx(cx1) }, { lat: gy(cy1), lng: gx(cx0) },
    ]
    const ox = hm?.outlet?.x ?? 0.85, oy = hm?.outlet?.y ?? 0.82
    const s = 0.15
    const garden = [
      { lat: gy(Math.max(0, oy - s / 2)), lng: gx(Math.max(0, ox - s / 2)) },
      { lat: gy(Math.max(0, oy - s / 2)), lng: gx(Math.min(1, ox + s / 2)) },
      { lat: gy(Math.min(1, oy + s / 2)), lng: gx(Math.min(1, ox + s / 2)) },
      { lat: gy(Math.min(1, oy + s / 2)), lng: gx(Math.max(0, ox - s / 2)) },
    ]
    setBusy(true)
    try {
      await addZone({ kind: 'drainage', name: 'Auto drain spine', polygon: spine })
      await addZone({ kind: 'green', name: 'Auto rain garden @ outlet', polygon: garden })
      notify('Proposed drainage spine + outlet rain garden added — drag to refine', 'success')
      await refresh()
    } catch (e) {
      setErr(serverMessage(e, 'Auto-drainage failed.'))
    }
    setBusy(false)
  }

  const exportPNG = async () => {
    if (!mapWrapRef.current) return
    setExportBusy(true)
    try {
      const canvas = await html2canvas(mapWrapRef.current, { useCORS: true, backgroundColor: '#0a1a33', scale: 2 })
      const a = document.createElement('a')
      a.href = canvas.toDataURL('image/png')
      a.download = `site-plan-plot${activeId}-${new Date().toISOString().slice(0, 10)}.png`
      document.body.appendChild(a)
      a.click()
      a.remove()
      notify('Plan snapshot downloaded (zones + legend + scale incur map tiles)', 'success')
    } catch {
      setErr('Snapshot failed — tile server blocked capture. Try the Streets basemap.')
    }
    setExportBusy(false)
  }

  const refresh = async () => {
    setErr('')
    try {
      const [z, p, a] = await Promise.all([loadZones(), loadPlans(), loadAssets().catch(() => [])])
      setZones(z)
      setPlans(p)
      setAssets(Array.isArray(a) ? a : [])
      try {
        const c = await loadConflicts()
        setConflicts(c.conflicts || [])
      } catch { setConflicts([]) }
    } catch (e) {
      setErr(serverMessage(e, 'Failed to load site plan data.'))
    }
  }

  useEffect(() => { setZones([]); setAssets([]); setConflicts([]); setPlans([]); setCorner(null); setVertices([]); setDrawing(false); refresh() }, [activeId]) // eslint-disable-line

  const savePoly = async (poly) => {
    if (!poly || poly.length < 3) {
      setErr('A zone needs at least 3 points.')
      return
    }
    setBusy(true)
    try {
      await addZone({ kind, name: zname.trim() || `${kind} zone`, polygon: poly })
      setCorner(null)
      setVertices([])
      setDrawing(false)
      await refresh()
    } catch (e) {
      setErr(serverMessage(e, 'Zone save failed.'))
    }
    setBusy(false)
  }

  const dropAsset = async (ll) => {
    setBusy(true)
    try {
      await addAsset({
        kind: assetKind,
        name: `${ASSET_LABEL[assetKind]} ${assets.length + 1}`,
        lat: +ll.lat.toFixed(6), lng: +ll.lng.toFixed(6),
        ...(assetKind === 'sump' ? { capacity_m3: Math.max(0, Number(assetCap) || 0) } : {}),
      })
      await refresh()
    } catch (e) {
      setErr(serverMessage(e, 'Asset save failed.'))
    }
    setBusy(false)
  }

  const onMapClick = async (ll) => {
    if (!drawing) return
    if (drawMode === 'asset') { await dropAsset(ll); return }
    if (drawMode === 'poly') {
      const pt = { lat: +ll.lat.toFixed(6), lng: +ll.lng.toFixed(6) }
      const last = vertices[vertices.length - 1]
      if (last && Math.abs(last.lat - pt.lat) < 1e-6 && Math.abs(last.lng - pt.lng) < 1e-6) return
      setVertices((v) => [...v, pt])
      return
    }
    if (!corner) { setCorner({ lat: ll.lat, lng: ll.lng }); return }
    await savePoly([
      { lat: corner.lat, lng: corner.lng },
      { lat: corner.lat, lng: ll.lng },
      { lat: ll.lat, lng: ll.lng },
      { lat: ll.lat, lng: corner.lng },
    ])
  }

  const cancelDraw = () => { setDrawing(false); setCorner(null); setVertices([]) }

  const applySync = (s) => {
    set({ simInputs: { ...simInputs, [s.key]: s.value } })
    notify(`Simulator ${s.key} ← ${s.value} m² from drawn zones`, 'success')
  }

  const onUpload = async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    setErr('')
    setBusy(true)
    try {
      await uploadPlan(file, {
        swLat: site.lat - 0.005, swLng: site.lng - 0.005,
        neLat: site.lat + 0.005, neLng: site.lng + 0.005,
      })
      await refresh()
    } catch (ex) {
      setErr(serverMessage(ex, 'Plan upload failed (images ≤ 5 MB).'))
    }
    setBusy(false)
    e.target.value = ''
  }

  if (!projects.length || activeId == null) {
    return (
      <div className="px-4 sm:px-6 pt-10 max-w-xl mx-auto">
        <Empty icon="🗺" title="No project selected" hint="Create a project and run analysis first — zones are checked against its traced flow path." />
      </div>
    )
  }

  return (
    <div className="px-4 sm:px-6 pt-5 pb-10 max-w-[1400px] mx-auto space-y-4">
      <PageHeader eyebrow="Site plan" title={`Zone tagging — ${project?.name || ''}`}
        sub="Tag building, parking, road, open space, drainage and green zones. The system checks each against the traced natural flow path." />

      {err && <ErrorBanner message={err} onDismiss={() => setErr('')} />}

      <div className="grid lg:grid-cols-5 gap-4">
        <div className="frame lg:col-span-3">
          <div className="frame-head">
            <div className="frame-title">Plan map <span className="frame-sub">· {drawing ? (corner ? 'click the opposite corner' : 'click the first corner') : 'zones + plan overlays'}</span></div>
            <div className="flex gap-1.5 flex-wrap">
              <Btn size="sm" variant="ghost" onClick={autoDrain} disabled={busy || !(hm?.flow_path || []).length} title="Draw a drainage spine along the traced flow + rain garden at the outlet">
                ✨ Auto-drainage
              </Btn>
              <Btn size="sm" variant="ghost" onClick={exportPNG} disabled={exportBusy}>
                {exportBusy ? 'Capturing…' : '⬇ Snapshot'}
              </Btn>
              <Btn size="sm" variant={drawing ? 'ghost' : 'violet'} onClick={() => (drawing ? cancelDraw() : setDrawing(true))}>
                {drawing ? 'Cancel drawing' : '+ Draw zone'}
              </Btn>
            </div>
          </div>
          <div ref={mapWrapRef}>
            <MapView lat={site.lat} lng={site.lng} flow={hm} onPick={onMapClick} height={440} zones={zones} plans={plans} assets={assets} envelope={env} draft={drawMode === 'poly' ? vertices : []} />
          </div>
          <div className="flex gap-2 mt-2 flex-wrap items-center">
            {!drawing ? (
              <span className="text-[11px] text-slate-500">Draw zones: rectangles or freehand polygons · areas feed the Simulator below.</span>
            ) : (
              <>
                <div className="flex rounded-full overflow-hidden border border-white/15">
                  {[['rect', '▭ Rectangle'], ['poly', '⬠ Polygon'], ['asset', '📍 Asset']].map(([m, label]) => (
                    <button key={m} onClick={() => { setDrawMode(m); setCorner(null); setVertices([]) }}
                      className={`text-[11px] px-2.5 py-1 font-bold ${drawMode === m ? 'bg-violet-400 text-[#0b1526]' : 'text-slate-300 hover:bg-white/10'}`}>
                      {label}
                    </button>
                  ))}
                </div>
                {drawMode === 'asset' ? (
                  <>
                    <select value={assetKind} onChange={(e) => setAssetKind(e.target.value)} className="field !w-auto !text-xs">
                      {ASSET_KINDS.map((k) => <option key={k} value={k}>{ASSET_LABEL[k]}</option>)}
                    </select>
                    {assetKind === 'sump' && (
                      <input type="number" value={assetCap} min={0} onChange={(e) => setAssetCap(e.target.value)}
                        placeholder="m³" title="Sump capacity m³" className="field !w-20 !text-xs" />
                    )}
                    <span className="text-[11px] text-slate-500">click the map to drop the asset</span>
                  </>
                ) : (
                  <>
                    <select value={kind} onChange={(e) => setKind(e.target.value)} className="field !w-auto !text-xs">
                      {KINDS.map((k) => <option key={k} value={k}>{k.replace('_', ' ')}</option>)}
                    </select>
                    <input value={zname} onChange={(e) => setZname(e.target.value)} placeholder="Zone name (optional)" className="field !w-40 !text-xs" />
                    {drawMode === 'poly' && (
                      <button disabled={busy || vertices.length < 3} onClick={() => savePoly(vertices)}
                        className="text-[11px] px-2.5 py-1 rounded-full bg-teal-400 text-[#0b1526] font-bold disabled:opacity-40">
                        ✓ Finish ({vertices.length} pts)
                      </button>
                    )}
                    <span className="text-[11px] text-slate-500">
                      {drawMode === 'rect'
                        ? (corner ? 'click the opposite corner' : 'click the first corner')
                        : 'click to add vertices, then Finish'}
                    </span>
                  </>
                )}
              </>
            )}
          </div>
        </div>

        <div className="space-y-4 lg:col-span-2">
          <Card title={`Conflicts (${conflicts.length})`} sub="zones intersecting the natural flow path">
            <div className="space-y-1.5 max-h-56 overflow-auto">
              {conflicts.map((c, i) => (
                <div key={i} className="text-xs bg-white/5 border border-white/10 rounded-xl px-3 py-2">
                  <span className={SEV_CHIP[c.severity] || 'chip-dim'}>{c.severity}</span>
                  <div className="text-slate-200 mt-1">{c.message}</div>
                </div>
              ))}
              {!conflicts.length && (
                <div className="text-xs text-slate-500">
                  {!hm ? 'Run Analyze on the Dashboard first — conflicts need the traced flow path.'
                    : zones.length ? 'No conflicts — zones clear the flow path.' : 'Tag a zone to check it.'}
                </div>
              )}
            </div>
          </Card>

          <Card title={`Zones (${zones.length})`} sub={areas.total ? `drawn ${areas.total.toLocaleString('en-IN')} m²` : ''}>
            <div className="space-y-1.5 max-h-48 overflow-auto">
              {areas.per.map((z) => (
                <div key={z.id} className="flex items-center gap-2 text-xs bg-white/5 border border-white/10 rounded-xl px-3 py-2">
                  <span className="chip-dim">{z.kind?.replace('_', ' ')}</span>
                  <span className="flex-1 truncate">{z.name}</span>
                  <span className="font-num text-teal-300">{z.area_m2.toLocaleString('en-IN')} m²</span>
                  <button disabled={busy} onClick={async () => { await deleteZone(z.id); await refresh() }} className="text-slate-500 hover:text-red-300">✕</button>
                </div>
              ))}
              {!zones.length && <div className="text-xs text-slate-500">No zones yet.</div>}
            </div>
            {!!suggestions.length && (
              <div className="mt-2 pt-2 border-t border-white/10 space-y-1.5">
                <div className="text-[11px] font-bold text-slate-300">Sync drawn areas → Simulator</div>
                {suggestions.map((s) => (
                  <button key={s.key} onClick={() => applySync(s)}
                    className="block w-full text-left text-[11px] px-2.5 py-1.5 rounded-xl bg-teal-500/10 border border-teal-400/30 text-teal-200 hover:bg-teal-500/20">
                    {s.label} →
                  </button>
                ))}
              </div>
            )}
          </Card>

          <Card title="Setbacks & envelope" sub="DCR margins in meters — confirm bye-laws">
            <div className="grid grid-cols-3 gap-1.5">
              {[['front', 'Front (road)'], ['side', 'Sides'], ['rear', 'Rear']].map(([k, label]) => (
                <label key={k} className="text-[10px] text-slate-400">
                  {label}
                  <input type="number" value={sb[k]} min={0} max={50} onChange={(e) => setSb({ ...sb, [k]: Number(e.target.value) })}
                    className="field !py-1 mt-0.5" />
                </label>
              ))}
            </div>
            {breaches.length > 0 ? (
              <div className="mt-2 space-y-1">
                {breaches.map((b) => (
                  <div key={b.id} className="text-[11px] bg-red-500/10 border border-red-400/30 rounded-xl px-2.5 py-1.5 text-red-200">
                    ⚠ <b>{b.name}</b> steps outside the envelope ({b.outside}/{b.total} corners) — shift it inside.
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-[11px] text-emerald-300 mt-2">✓ Building zones respect the envelope.</div>
            )}
          </Card>

          <Card title="Parking ECS" sub="1 bay per 12.5 m² drawn parking">
            <div className="flex items-center gap-2 text-xs">
              <span className="font-num text-xl font-bold text-slate-100">{parking.provided}</span>
              <span className="text-slate-400">bays drawn vs <b className="text-slate-200 font-num">{parking.required}</b> required</span>
              <span className={`ml-auto text-[11px] font-bold px-2 py-0.5 rounded-full ${parking.pass ? 'bg-emerald-500/15 text-emerald-300' : 'bg-red-500/15 text-red-300'}`}>
                {parking.pass ? '✓ enough' : '✕ shortfall'}
              </span>
            </div>
            <label className="block text-[10px] text-slate-500 mt-1.5">
              Required bays per 100 m² footprint
              <input type="number" value={parkPer100} min={0} step={0.5} onChange={(e) => setParkPer100(Number(e.target.value))}
                className="field !py-1 mt-0.5 !w-24" />
            </label>
          </Card>

          <Card title={`Assets (${assets.length})`} sub="pits, sumps & pumps feed the BOQ">
            <div className="space-y-1.5 max-h-48 overflow-auto">
              {assets.map((a) => (
                <div key={a.id} className="flex items-center gap-2 text-xs bg-white/5 border border-white/10 rounded-xl px-3 py-2">
                  <span className="chip-dim">{ASSET_LABEL[a.kind] || a.kind}</span>
                  <span className="flex-1 truncate">{a.name}{a.kind === 'sump' && a.capacity_m3 != null ? ` · ${a.capacity_m3} m³` : ''}</span>
                  <button disabled={busy} onClick={async () => { await deleteAsset(a.id); await refresh() }} className="text-slate-500 hover:text-red-300">✕</button>
                </div>
              ))}
              {!assets.length && <div className="text-xs text-slate-500">No assets — draw mode → Asset, then click the map.</div>}
            </div>
            {!!assets.length && (
              <div className="text-[11px] text-slate-400 mt-2 pt-2 border-t border-white/10">
                {assets.filter((a) => a.kind === 'recharge_pit').length} pits ·{' '}
                {assets.filter((a) => a.kind === 'sump').reduce((s, a) => s + (Number(a.capacity_m3) || 0), 0)} m³ sump ·{' '}
                {assets.filter((a) => a.kind === 'pump').length} pumps → counted in the Report BOQ
              </div>
            )}
          </Card>

          <Card title="Plan image" sub="PNG/JPEG ≤ 5 MB, auto-aligned to the site extent">
            <label className="btn-ghost btn-sm cursor-pointer">
              {busy ? 'Working…' : '⬆ Upload plan'}
              <input type="file" accept="image/*" className="hidden" onChange={onUpload} />
            </label>
            <div className="space-y-1.5 mt-2">
              {plans.map((p) => (
                <div key={p.id} className="flex items-center gap-2 text-xs bg-white/5 border border-white/10 rounded-xl px-3 py-2">
                  <span className="flex-1 truncate">{p.filename}</span>
                  <span className="text-slate-500 font-num">{(p.bytes / 1024).toFixed(0)} KB</span>
                  <button disabled={busy} onClick={async () => { await deletePlan(p.id); await refresh() }} className="text-slate-500 hover:text-red-300">✕</button>
                </div>
              ))}
              {!plans.length && <div className="text-xs text-slate-500">No plan uploaded.</div>}
            </div>
          </Card>
        </div>
      </div>
    </div>
  )
}
