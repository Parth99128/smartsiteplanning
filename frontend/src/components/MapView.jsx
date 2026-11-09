import { useEffect, useMemo, useRef, useState } from 'react'
import { MapContainer, TileLayer, Marker, Polyline, CircleMarker, Rectangle, ImageOverlay, useMap, useMapEvents } from 'react-leaflet'
import 'leaflet/dist/leaflet.css'
import L from 'leaflet'
import { api } from '../api'
import { drainToLatLngs, DRAIN_COLOR } from '../lib/siteContext'

const ASSET_COLOR = { recharge_pit: '#34d399', sump: '#38bdf8', pump: '#facc15' }
// fix default icon
delete L.Icon.Default.prototype._getIconUrl
L.Icon.Default.mergeOptions({ iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png', iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png', shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png' })

/* Keyless tile providers (no API keys, generous free use).
   CARTO basemaps were dropped: they now watermark "API KEY REQUIRED".
   Satellite is hybrid: Esri imagery + reference overlay so place/road names
   stay visible (pure imagery has no labels). */
const PROVIDERS = {
  streets: {
    label: 'Streets',
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '© OpenStreetMap contributors',
    maxZoom: 19,
  },
  satellite: {
    label: 'Satellite',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Tiles © Esri — Source: Esri, Maxar, Earthstar Geographics',
    maxZoom: 19,
    labels: [
      'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}',
      'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
    ],
  },
  dark: {
    label: 'Dark',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Tiles © Esri — Esri, HERE, Garmin, OpenStreetMap contributors',
    maxZoom: 16,
    labels: [
      'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
    ],
  },
}

/* Place search (Nominatim, keyless). Officers type "Velachery" → pin flies there. */
function SearchBox({ onPick }) {
  const map = useMap()
  const [q, setQ] = useState('')
  const [results, setResults] = useState([])
  const [busy, setBusy] = useState(false)
  const search = async () => {
    const query = q.trim()
    if (query.length < 3) return
    setBusy(true)
    try {
      const c = map.getCenter()
      const r = await fetch(
        `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&countrycodes=in&lat=${c.lat}&lon=${c.lng}&q=${encodeURIComponent(query)}`,
        { headers: { Accept: 'application/json' } })
      if (r.ok) setResults(await r.json())
    } catch { /* offline */ }
    setBusy(false)
  }
  const go = (r) => {
    const lat = Number(r.lat), lng = Number(r.lon)
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return
    map.flyTo([lat, lng], Math.max(map.getZoom(), 15), { duration: 0.8 })
    onPick?.({ lat, lng })
    setResults([])
    setQ(r.display_name?.split(',').slice(0, 2).join(',') || '')
  }
  return (
    <div className="absolute top-2 right-2 z-[500] w-[min(240px,55%)]">
      <div className="flex gap-1 p-1 rounded-full bg-slate-950/70 backdrop-blur border border-white/15">
        <input value={q} onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && search()}
          placeholder="Search place…"
          className="flex-1 min-w-0 bg-transparent text-[11px] px-2 py-1 outline-none text-slate-100 placeholder:text-slate-500" />
        <button onClick={search} disabled={busy}
          className="text-[11px] px-2.5 py-1 rounded-full font-bold bg-teal-400 text-[#0b1526] disabled:opacity-50">
          {busy ? '…' : '🔍'}
        </button>
      </div>
      {results.length > 0 && (
        <div className="mt-1 rounded-xl overflow-hidden bg-slate-950/90 backdrop-blur border border-white/15 shadow-xl">
          {results.map((r, i) => (
            <button key={i} onClick={() => go(r)}
              className="block w-full text-left text-[11px] px-3 py-1.5 hover:bg-white/10 text-slate-200 truncate">
              📍 {r.display_name?.split(',').slice(0, 3).join(',')}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function Clicker({ onPick }) {
  useMapEvents({ click(e) { onPick?.(e.latlng) } })
  return null
}

function Recenter({ lat, lng }) {
  const map = useMap()
  useEffect(() => {
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      map.flyTo([lat, lng], Math.max(map.getZoom(), 14), { duration: 0.8 })
    }
  }, [lat, lng]) // eslint-disable-line
  return null
}

const moveIcon = L.divIcon({
  className: 'bldg-move-icon',
  html: '<div style="width:26px;height:26px;border-radius:9999px;background:rgba(251,191,36,.92);color:#0b1526;font-weight:900;display:grid;place-items:center;font-size:14px;box-shadow:0 0 14px #fbbf24;cursor:move;">✥</div>',
  iconSize: [26, 26],
  iconAnchor: [13, 13],
})

/* Draggable proposed-building footprint (normalized center + fixed 0.25 size,
   matching the backend flow-path bbox). Dragging moves the block; the flow
   path + risk rebuild for the new position. */
function BuildingFootprint({ cx, cy, toGeo, fromLatLng, onMove }) {
  const ref = useRef(null)
  const handlers = useMemo(() => ({
    dragend() {
      const m = ref.current
      if (m) onMove?.(fromLatLng(m.getLatLng()))
    },
  }), [onMove, fromLatLng])
  const bounds = [toGeo(cx - 0.125, cy - 0.125), toGeo(cx + 0.125, cy + 0.125)]
  return (
    <>
      <Rectangle bounds={bounds}
        pathOptions={{ color: '#fbbf24', weight: 2.5, fillColor: '#fbbf24', fillOpacity: 0.12 }} />
      {onMove && (
        <Marker position={toGeo(cx, cy)} icon={moveIcon} draggable
          eventHandlers={handlers} ref={ref} zIndexOffset={1000} />
      )}
    </>
  )
}

function DraggablePin({ lat, lng, onPick }) {
  const ref = useRef(null)
  const eventHandlers = useMemo(() => ({
    dragend() {
      const m = ref.current
      if (m) {
        const ll = m.getLatLng()
        onPick?.({ lat: ll.lat, lng: ll.lng })
      }
    },
  }), [onPick])
  return <Marker position={[lat, lng]} draggable={!!onPick} eventHandlers={eventHandlers} ref={ref} />
}

/* 2D site map: flow overlay color-coded by elevation, switchable keyless tiles.
   Props: lat, lng (pin), flow (heightmap payload), onPick({lat,lng}) — enables
   click-to-place AND marker dragging; height (px), zoom, follow (recenter),
   placements (dashed intervention boxes, normalized coords),
   zones ([{polygon, kind, name}]), plans (site-plan image overlays). */
export default function MapView({ lat, lng, flow, onPick, height = 380, zoom = 15, follow = true, placements = [], zones = [], plans = [], drains = [], inlets = [], building = null, onMoveBuilding = null, draft = [], assets = [], envelope = null }) {
  const [provider, setProvider] = useState('streets')
  const safeLat = Number.isFinite(Number(lat)) ? Number(lat) : 23.082
  const safeLng = Number.isFinite(Number(lng)) ? Number(lng) : 72.493
  const toGeo = (nx, ny) => [safeLat - 0.005 + ny * 0.01, safeLng - 0.005 + nx * 0.01]
  const fromLatLng = (ll) => {
    const nx = Math.max(0.125, Math.min(0.875, (ll.lng - (safeLng - 0.005)) / 0.01))
    const ny = Math.max(0.125, Math.min(0.875, (ll.lat - (safeLat - 0.005)) / 0.01))
    return { cx: +nx.toFixed(4), cy: +ny.toFixed(4) }
  }
  const PLACE_COLOR = { corridor: '#e879f9', outlet: '#22d3ee', midflow: '#2dd4bf', building: '#fbbf24' }
  const ZONE_COLOR = { building: '#f87171', parking: '#fb923c', road: '#facc15', open_space: '#94a3b8', drainage: '#22d3ee', green: '#34d399' }
  const prov = PROVIDERS[provider] || PROVIDERS.streets

  const { line, depths, outlet } = useMemo(() => {
    const fp = flow?.flow_path || []
    let mn = 1e9, mx = -1e9
    fp.forEach((p) => { mn = Math.min(mn, p.h); mx = Math.max(mx, p.h) })
    const pts = fp.filter((_, i) => i % 3 === 0).map((p) => ({
      pos: [safeLat - 0.005 + p.y * 0.01, safeLng - 0.005 + p.x * 0.01],
      t: (p.h - mn) / Math.max(1e-6, mx - mn),
    }))
    return {
      line: pts.map((d) => d.pos),
      depths: pts,
      outlet: flow?.outlet ? [safeLat - 0.005 + flow.outlet.y * 0.01, safeLng - 0.005 + flow.outlet.x * 0.01] : null,
    }
  }, [flow, safeLat, safeLng])

  return (
    <div className="relative">
      <MapContainer center={[safeLat, safeLng]} zoom={zoom} maxZoom={19} worldCopyJump
        style={{ height, borderRadius: 16 }}>
        <TileLayer url={prov.url} attribution={prov.attribution} maxZoom={prov.maxZoom} />
        {(prov.labels || []).map((url, i) => (
          <TileLayer key={`lbl-${i}`} url={url} maxZoom={prov.maxZoom} zIndex={10 + i} opacity={0.95} />
        ))}
        <Clicker onPick={onPick} />
        <SearchBox onPick={onPick} />
        {follow && <Recenter lat={safeLat} lng={safeLng} />}
        <DraggablePin lat={safeLat} lng={safeLng} onPick={onPick} />
        {building && Number.isFinite(building.cx) && Number.isFinite(building.cy) && (
          <BuildingFootprint cx={building.cx} cy={building.cy}
            toGeo={toGeo} fromLatLng={fromLatLng} onMove={onMoveBuilding} />
        )}
        {envelope && Number.isFinite(envelope.sw?.[0]) && (
          <Rectangle bounds={[envelope.sw, envelope.ne]}
            pathOptions={{ color: '#e2e8f0', weight: 1.5, dashArray: '3 5', fill: false }} />
        )}
        {plans.map((p) => (
          <ImageOverlay key={`plan-${p.id}`} url={`${api.defaults.baseURL}/site-plans/${p.id}/image`}
            bounds={[[p.sw_lat, p.sw_lng], [p.ne_lat, p.ne_lng]]} opacity={0.65} zIndex={5} />
        ))}
        {(draft || []).length > 1 && (
          <Polyline positions={[...draft.map((p) => [p.lat, p.lng]), [draft[0].lat, draft[0].lng]]}
            pathOptions={{ color: '#fbbf24', weight: 2, dashArray: '4 4', fillColor: '#fbbf24', fillOpacity: 0.1, fill: true }} />
        )}
        {(draft || []).map((p, i) => (
          <CircleMarker key={`draft-${i}`} center={[p.lat, p.lng]} radius={4}
            pathOptions={{ color: '#fbbf24', fillColor: '#fbbf24', fillOpacity: 0.9, weight: 2 }} />
        ))}
        {zones.map((z) => {
          const pts = (z.polygon || []).map((pt) => Array.isArray(pt) ? [pt[0], pt[1]] : [pt.lat, pt.lng]).filter((pt) => pt.every(Number.isFinite))
          if (pts.length < 3) return null
          const c = ZONE_COLOR[z.kind] || '#94a3b8'
          return <Polyline key={`zone-${z.id}`} positions={[...pts, pts[0]]} pathOptions={{ color: c, weight: 2, dashArray: '6 4', fillColor: c, fillOpacity: 0.15, fill: true }} />
        })}
        {placements.map((pl, i) => {
          const b = pl?.bbox
          if (!b || ![b.x, b.y, b.w, b.d].every(Number.isFinite)) return null
          const c = PLACE_COLOR[pl.zone] || '#22d3ee'
          return <Rectangle key={`pl-${i}`} bounds={[toGeo(b.x, b.y), toGeo(b.x + b.w, b.y + b.d)]}
            pathOptions={{ color: c, weight: 2, dashArray: '8 5', fillColor: c, fillOpacity: 0.08 }} />
        })}
        {(drains || []).map((d) => {
          const pts = drainToLatLngs(d.geom, safeLat, safeLng)
          if (pts.length < 2) return null
          const c = DRAIN_COLOR[d.kind] || '#22d3ee'
          const dashed = d.kind === 'sewer' || (d.status === 'proposed')
          return <Polyline key={`drain-${d.id}`} positions={pts}
            pathOptions={{ color: c, weight: d.kind === 'river' ? 5 : 3, opacity: 0.9, dashArray: dashed ? '7 5' : undefined }} />
        })}
        {(inlets || []).map((p) => (
          Number.isFinite(p.lat) && Number.isFinite(p.lng)
            ? <CircleMarker key={`inlet-${p.id}`} center={[p.lat, p.lng]} radius={4}
              pathOptions={{ color: '#e879f9', fillColor: '#d946ef', fillOpacity: 0.9, weight: 1.5 }} />
            : null
        ))}
        {(assets || []).map((a) => (
          Number.isFinite(a.lat) && Number.isFinite(a.lng)
            ? <CircleMarker key={`asset-${a.id}`} center={[a.lat, a.lng]} radius={6}
              pathOptions={{ color: ASSET_COLOR[a.kind] || '#34d399', fillColor: ASSET_COLOR[a.kind] || '#34d399', fillOpacity: 0.85, weight: 2 }} />
            : null
        ))}
        {line.length > 1 && <Polyline positions={line} pathOptions={{ color: '#06b6d4', weight: 4, opacity: 0.9 }} />}
        {depths.map((d, i) => (
          <CircleMarker key={i} center={d.pos} radius={4}
            pathOptions={{ color: d.t < 0.4 ? '#22d3ee' : d.t < 0.7 ? '#facc15' : '#fb923c', fillOpacity: 0.85, weight: 1 }} />
        ))}
        {outlet && <CircleMarker center={outlet} radius={7} pathOptions={{ color: '#e879f9', fillColor: '#d946ef', fillOpacity: 0.9, weight: 2 }} />}
      </MapContainer>
      <div className="absolute top-2 left-12 z-[500] flex gap-1 p-1 rounded-full bg-slate-950/70 backdrop-blur border border-white/15">
        {Object.entries(PROVIDERS).map(([key, p]) => (
          <button key={key} onClick={() => setProvider(key)}
            className={`text-[11px] px-2.5 py-1 rounded-full font-bold transition ${provider === key ? 'bg-teal-400 text-[#0b1526]' : 'text-slate-300 hover:bg-white/10'}`}>
            {p.label}
          </button>
        ))}
      </div>
      {onPick && (
        <div className="absolute bottom-8 left-2 z-[500] text-[10px] bg-slate-950/70 backdrop-blur border border-white/15 rounded-full px-2.5 py-1 text-slate-300">
          📍 click map or drag pin
        </div>
      )}
      {(depths.length > 0 || (drains || []).length > 0 || (inlets || []).length > 0 || outlet || (zones || []).length > 0) && (
        <div className="absolute bottom-2 left-2 z-[500] text-[10px] bg-slate-950/70 backdrop-blur border border-white/15 rounded-full px-2.5 py-1 flex gap-2 flex-wrap max-w-[70%] text-slate-300">
          {depths.length > 0 && (
            <>
              <span><i className="inline-block w-2 h-2 rounded-full bg-cyan-400" /> flow low</span>
              <span><i className="inline-block w-2 h-2 rounded-full bg-yellow-400" /> mid</span>
              <span><i className="inline-block w-2 h-2 rounded-full bg-orange-400" /> high</span>
            </>
          )}
          {(drains || []).some((d) => d.kind !== 'sewer') && (
            <span title="Municipal open drains / nallas from the city registry">— <b className="text-cyan-300">open drain</b></span>
          )}
          {(drains || []).some((d) => d.kind === 'sewer') && (
            <span title="Buried sewer line (dashed = underground, from the city registry)">┄ <b className="text-violet-300">buried sewer</b></span>
          )}
          {(inlets || []).length > 0 && (
            <span title="Drain chamber / inlet where road runoff enters the network"><i className="inline-block w-2 h-2 rounded-full bg-fuchsia-400" /> chamber</span>
          )}
          {outlet && (
            <span title="Where the traced flow leaves the site"><i className="inline-block w-2.5 h-2.5 rounded-full bg-fuchsia-500 border border-fuchsia-200" /> outlet</span>
          )}
          {(zones || []).length > 0 && (
            <span title="Officer-tagged site zone (colour set by zone kind)">▭ tagged zone</span>
          )}
          {building && (
            <span title="Your proposed building — drag the ✥ handle to move it; flow + risk rebuild"><b className="text-amber-300">▭ proposed block{onMoveBuilding ? ' (draggable)' : ''}</b></span>
          )}
          {envelope && (
            <span title="Buildable envelope after DCR setbacks (front = road side)">▭ envelope</span>
          )}
          {(assets || []).some((a) => a.kind === 'recharge_pit') && (
            <span title="Planned recharge pit (your design)"><i className="inline-block w-2.5 h-2.5 rounded-full bg-emerald-400" /> recharge pit</span>
          )}
          {(assets || []).some((a) => a.kind === 'sump') && (
            <span title="Planned storage sump (your design)"><i className="inline-block w-2.5 h-2.5 rounded-full bg-sky-400" /> sump</span>
          )}
          {(assets || []).some((a) => a.kind === 'pump') && (
            <span title="Planned pump (your design)"><i className="inline-block w-2.5 h-2.5 rounded-full bg-yellow-400" /> pump</span>
          )}
        </div>
      )}
    </div>
  )
}
