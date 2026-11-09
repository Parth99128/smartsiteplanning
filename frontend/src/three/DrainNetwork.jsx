import { useMemo, useRef, useEffect } from 'react'
import { Html } from '@react-three/drei'
import * as THREE from 'three'

const M2WORLD = 0.45 // must match Terrain3D or drains float off the terrain
const WORLD = 24

/* Municipal drains + chambers inside the R3F twin.
   drains: [{id, kind, geom:[[nx,ny]...], dist_m}] (normalized 0..1 site frame)
   inlets: [{id, x, y}] normalized — rendered as magenta markers on terrain.
   surchargedIds: string[] from hydraulics → pulsing red.
   grid: elevation grid for drape height. xray: dim terrain handled by parent. */

const KIND_COLOR = {
  storm: '#22d3ee', open_drain: '#22d3ee', nalla: '#eab308',
  canal: '#38bdf8', river: '#60a5fa', sewer: '#a78bfa', lake_link: '#34d399',
}

function heightAt(grid, nx, ny) {
  const n = grid?.length || 0
  if (!n) return 0 // site-relative grid: base sits at 0
  const ix = Math.max(0, Math.min(n - 1, Math.round(nx * (n - 1))))
  const iz = Math.max(0, Math.min(n - 1, Math.round(ny * (n - 1))))
  const v = grid[iz]?.[ix]
  return Number.isFinite(v) ? v : 0
}

function toWorld(nx, ny, grid, lift, buried) {
  const h = heightAt(grid, nx, ny)
  const y = h * M2WORLD + (buried ? -0.9 : lift)
  return new THREE.Vector3((nx - 0.5) * WORLD, y, (ny - 0.5) * WORLD)
}

function DrainTube({ drain, grid, surcharged }) {
  const geo = useMemo(() => {
    const pts = (drain.geom || []).filter((p) => p.length >= 2)
    if (pts.length < 2) return null
    const buried = drain.kind === 'sewer'
    const v = pts.map(([nx, ny]) => toWorld(nx, ny, grid, 0.22, buried))
    if (v.length < 2) return null
    try {
      return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(v), 48, buried ? 0.07 : 0.09, 6, false)
    } catch { return null }
  }, [drain, grid])
  const mat = useRef()
  useEffect(() => () => geo?.dispose(), [geo])
  if (!geo) return null
  const base = KIND_COLOR[drain.kind] || '#22d3ee'
  return (
    <mesh geometry={geo}>
      <meshStandardMaterial ref={mat} color={surcharged ? '#ef4444' : base}
        emissive={surcharged ? '#7f1d1d' : base} emissiveIntensity={surcharged ? 1.8 : 0.7}
        transparent opacity={0.9} roughness={0.3} />
    </mesh>
  )
}

function InletMarkers({ inlets, grid }) {
  const items = useMemo(() => {
    if (!inlets?.length || !grid?.length) return []
    return inlets.slice(0, 100).map((p) => {
      const nx = Number(p.x), ny = Number(p.y)
      if (!Number.isFinite(nx) || !Number.isFinite(ny)) return null
      const h = heightAt(grid, nx, ny)
      return { id: p.id, pos: [(nx - 0.5) * WORLD, h * M2WORLD + 0.35, (ny - 0.5) * WORLD] }
    }).filter(Boolean)
  }, [inlets, grid])
  if (!items.length) return null
  return (
    <group>
      {items.map((it) => (
        <mesh key={it.id} position={it.pos}>
          <octahedronGeometry args={[0.16]} />
          <meshStandardMaterial color="#e879f9" emissive="#a21caf" emissiveIntensity={1.6} />
        </mesh>
      ))}
    </group>
  )
}

export default function DrainNetwork({ drains = [], inlets = [], surchargedIds = [], grid }) {
  const set = useMemo(() => new Set(surchargedIds || []), [surchargedIds])
  const shown = useMemo(() => (drains || []).slice(0, 120), [drains])
  if ((!shown.length && !inlets?.length) || !grid?.length) return null
  const nSurcharged = shown.filter((d) => set.has(d.id)).length
  const outlet = useMemo(() => {
    let best = null
    for (const d of shown) {
      const g = d.geom || []
      if (g.length >= 2) {
        const last = g[g.length - 1]
        if (!best || (d.dist_m ?? 1e9) > (best.dist_m ?? 0)) best = { ...d, tip: last }
      }
    }
    return best?.tip || null
  }, [shown])
  return (
    <group>
      {shown.map((d) => (
        <DrainTube key={d.id} drain={d} grid={grid} surcharged={set.has(d.id)} />
      ))}
      <InletMarkers inlets={inlets} grid={grid} />
      {outlet && (
        <Html position={[(outlet[0] - 0.5) * WORLD, 2.6, (outlet[1] - 0.5) * WORLD]} center zIndexRange={[5, 0]}>
          <div className="text-[10px] px-2 py-0.5 rounded-full font-bold whitespace-nowrap bg-cyan-500/90 text-white shadow-[0_0_14px_#22d3ee]">
            DRAIN OUTLET{nSurcharged ? ` · ${nSurcharged} SURCHARGED` : ''}
          </div>
        </Html>
      )}
    </group>
  )
}
