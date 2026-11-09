import { useEffect, useRef, useState } from 'react'
import MapView from './MapView'
import { Btn, ErrorBanner } from './ui'
import { useStore } from '../store'
import { serverMessage } from '../lib/api'
import { fetchSiteContext } from '../lib/siteContext'

const DEFAULT_CENTER = { lat: 23.082, lng: 72.493 }

/* Reverse-geocode a pin to a human label (best-effort, offline-safe). */
async function reverseLabel(lat, lng, signal) {
  try {
    const r = await fetch(
      `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=jsonv2&zoom=14`,
      { headers: { Accept: 'application/json' }, signal })
    if (!r.ok) return ''
    const j = await r.json()
    return j.display_name?.split(',').slice(0, 3).join(',') || ''
  } catch { return '' }
}

function Step({ n, title, sub, children }) {
  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        <span className="w-5 h-5 rounded-full bg-teal-400 text-[#0b1526] text-[11px] font-extrabold grid place-items-center shrink-0">{n}</span>
        <div className="font-bold text-[14px]">{title} <span className="text-xs font-normal text-slate-400">{sub}</span></div>
      </div>
      {children}
    </div>
  )
}

/* Map-first project creation: pick on map → system detects factors → create & analyze.
   Used in the Dashboard empty state and the sidebar. onCreated() fires after success. */
export default function CreateProjectWizard({ compact = false, onCreated }) {
  const createAndAnalyze = useStore((s) => s.createAndAnalyze)
  const estimateSite = useStore((s) => s.estimateSite)
  const notify = useStore((s) => s.notify)
  const [name, setName] = useState('')
  const [footprint, setFootprint] = useState(800)
  const [pin, setPin] = useState(null)
  const [label, setLabel] = useState('')
  const [detected, setDetected] = useState(null)
  const [detecting, setDetecting] = useState(false)
  const [registry, setRegistry] = useState(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const labelCtl = useRef(null)

  // Auto-detect whenever the pin settles.
  useEffect(() => {
    if (!pin) { setDetected(null); setLabel(''); setRegistry(null); return }
    let dead = false
    setDetecting(true)
    labelCtl.current?.abort()
    labelCtl.current = new AbortController()
    const t = setTimeout(async () => {
      try {
        const [est, lbl, rc] = await Promise.all([
          estimateSite(pin.lat, pin.lng, Number(footprint) || 800),
          reverseLabel(pin.lat, pin.lng, labelCtl.current.signal),
          fetchSiteContext(pin.lat, pin.lng).catch(() => null),
        ])
        if (!dead) {
          setDetected(est?.factors || null)
          setRegistry(rc?.city ? rc : null)
          setLabel(lbl)
          if (!name) {
            const area = lbl?.split(',')[0]?.trim()
            if (area) setName(`${area} site`)
          }
        }
      } catch {
        if (!dead) setDetected(null)
      }
      if (!dead) setDetecting(false)
    }, 450)
    return () => { dead = true; clearTimeout(t) }
    // eslint-disable-next-line
  }, [pin?.lat, pin?.lng])

  const pick = (ll) => setPin({ lat: +ll.lat.toFixed(6), lng: +ll.lng.toFixed(6) })

  const submit = async (e) => {
    e?.preventDefault()
    setErr('')
    if (!name.trim()) return setErr('Give the site a name.')
    if (!pin) return setErr('Click the map to drop a pin first.')
    const fp = Number(footprint)
    if (!Number.isFinite(fp) || fp <= 0 || fp > 100000) return setErr('Footprint must be 1..100000 m².')
    setBusy(true)
    try {
      await createAndAnalyze({ name: name.trim(), lat: pin.lat, lng: pin.lng, footprint_sqm: fp })
      notify(`Project created @ ${pin.lat.toFixed(4)}, ${pin.lng.toFixed(4)} — analysis running`, 'success')
      onCreated?.()
    } catch (e2) {
      setErr(serverMessage(e2, 'Creation failed — is the backend running?'))
    }
    setBusy(false)
  }

  const f = detected || {}
  const facts = [
    ['Rainfall', `${f.rainfall_mm ?? '—'} mm`], ['Elevation', `${f.elevation_m ?? '—'} m`],
    ['Slope', `${f.slope_deg ?? '—'}°`], ['Dist. to water', `${f.dist_water_m ?? '—'} m`],
    ['Drainage density', f.drainage_density ?? '—'], ['Infiltration', `${f.soil_infiltration_mmhr ?? '—'} mm/h`],
    ['Impervious', `${f.impervious_pct ?? '—'}%`], ['Past floods', f.hist_flood_count ?? '—'],
  ]

  return (
    <form onSubmit={submit} className={compact ? 'space-y-3' : 'grid lg:grid-cols-2 gap-4'}>
      <div className="frame">
        <Step n="1" title="Pick the site" sub="click anywhere on the map" />
        <MapView lat={pin?.lat ?? DEFAULT_CENTER.lat} lng={pin?.lng ?? DEFAULT_CENTER.lng}
          flow={null} onPick={pick} height={compact ? 230 : 330} zoom={13} />
        <div className="mt-2.5 text-xs flex flex-wrap gap-2 items-center min-h-6">
          {pin ? (
            <>
              <span className="chip-info font-num">📍 {pin.lat.toFixed(5)}, {pin.lng.toFixed(5)}</span>
              {label && <span className="text-slate-400 truncate max-w-full">{label}</span>}
              <button type="button" onClick={() => setPin(null)} className="text-slate-500 underline underline-offset-2">clear</button>
            </>
          ) : <span className="text-slate-500">No pin yet — click the map.</span>}
        </div>
      </div>

      <div className="frame space-y-3.5">
        <Step n="2" title="System detects the ground" sub="per-pin factors">
          {!pin && <div className="text-[13px] text-slate-500">Drop a pin to detect rainfall, terrain, drainage and flood history for that exact spot.</div>}
          {pin && detecting && <div className="flex items-center gap-2 text-[13px] text-slate-400"><span className="w-3.5 h-3.5 rounded-full border-2 border-teal-300 border-t-transparent animate-spin" /> Detecting ground conditions…</div>}
          {pin && !detecting && detected && (
            <div>
              <div className="grid grid-cols-2 gap-1.5">
                {facts.map(([k, v]) => (
                  <div key={k} className="bg-white/[.04] border border-white/10 rounded-xl px-2.5 py-1.5 flex justify-between gap-2">
                    <span className="text-slate-400 text-[11px]">{k}</span><b className="font-num text-slate-100 text-[12px]">{v}</b>
                  </div>
                ))}
              </div>
              {registry ? (
                <div className="text-[11px] mt-1.5 text-cyan-300 bg-cyan-500/10 border border-cyan-400/30 rounded-xl px-3 py-1.5">
                  🌊 {registry.city} municipal registry · {registry.drains?.length || 0} drains
                  {registry.inlets?.length ? ` · ${registry.inlets.length} chambers` : ''}
                  {' '}· {(registry.confidence * 100).toFixed(0)}% confidence — measured, not predicted.
                </div>
              ) : (
                <div className="text-[10px] text-slate-500 mt-1.5">Geo-derived planning estimate — replace with survey for construction use. Outside Chennai / Bengaluru / Pune / Nashik pilot registries.</div>
              )}
            </div>
          )}
          {pin && !detecting && !detected && (
            <div className="text-[12px] text-amber-300 bg-amber-500/10 border border-amber-400/30 rounded-xl px-3 py-2">Backend unreachable — you can still create; detection retries automatically.</div>
          )}
        </Step>

        <Step n="3" title="Name & create" sub="analysis runs immediately">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. SG Highway Plot D" className="field" />
          <label className="block text-xs text-slate-300 mt-2">
            <span className="flex justify-between mb-1"><span>Footprint</span><b className="font-num text-teal-300">{footprint} m²</b></span>
            <input type="range" min={200} max={2000} step={10} value={footprint}
              onChange={(e) => setFootprint(Number(e.target.value))} />
          </label>
        </Step>

        {err && <ErrorBanner message={err} onDismiss={() => setErr('')} />}
        <Btn variant="primary" disabled={busy || !pin} className="w-full !py-3">
          {busy ? 'Creating & analyzing…' : '📍 Create site & run analysis'}
        </Btn>
      </div>
    </form>
  )
}
