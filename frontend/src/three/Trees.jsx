import { useMemo, useRef, useEffect } from 'react'
import * as THREE from 'three'

const M2WORLD = 0.45 // must match Terrain3D
const WORLD = 24

/* Planned urban greenery: avenue rows along the site border + clusters on
   higher ground (never in the building plot, flow path or drain lines).
   Placement is deterministically seeded from the terrain so the same site
   always grows the same trees. */

function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function gridHeightAt(grid, nx, ny) {
  const n = grid.length
  if (!n) return 0 // site-relative grid: base sits at 0
  const ix = Math.max(0, Math.min(n - 1, Math.round(nx * (n - 1))))
  const iz = Math.max(0, Math.min(n - 1, Math.round(ny * (n - 1))))
  const v = grid[iz]?.[ix]
  return Number.isFinite(v) ? v : 0
}

const inBuilding = (nx, ny, bcx = 0.475, bcy = 0.475, half = 0.155) =>
  nx > bcx - half && nx < bcx + half && ny > bcy - half && ny < bcy + half

function nearFlow(nx, ny, flowPath) {
  for (const p of flowPath || []) {
    const dx = p.x - nx, dy = p.y - ny
    if (dx * dx + dy * dy < 0.035 * 0.035) return true
  }
  return false
}

function nearDrain(nx, ny, drains) {
  for (const d of drains || []) {
    for (const pt of d.geom || []) {
      const dx = pt[0] - nx, dy = pt[1] - ny
      if (dx * dx + dy * dy < 0.02 * 0.02) return true
    }
  }
  return false
}

export default function Trees({ grid, flowPath = [], drains = [], greenSqm = 400, bcx = 0.475, bcy = 0.475 }) {
  const trunkRef = useRef()
  const crownRef = useRef()

  const spots = useMemo(() => {
    if (!grid?.length) return []
    // seed from terrain content
    let h = 2166136261
    const flat = grid.flat()
    for (let i = 0; i < flat.length; i += 7) {
      h ^= Math.round(flat[i] * 100)
      h = Math.imul(h, 16777619)
    }
    const rnd = mulberry32(h)
    const out = []

    // 1. avenue rows: inset border, regular spacing with slight jitter
    const inset = 0.045, step = 0.062
    for (let t = inset; t <= 1 - inset + 1e-6; t += step) {
      for (const [nx, ny] of [[t, inset], [t, 1 - inset], [inset, t], [1 - inset, t]]) {
        const jx = nx + (rnd() - 0.5) * 0.012, jy = ny + (rnd() - 0.5) * 0.012
        if (!inBuilding(jx, jy, bcx, bcy) && !nearFlow(jx, jy, flowPath) && !nearDrain(jx, jy, drains)) {
          out.push({ nx: jx, ny: jy, s: 0.85 + rnd() * 0.4 })
        }
      }
    }

    // 2. green pockets: prefer higher cells (dry ground), capped by green area
    const sorted = [...flat].sort((a, b) => a - b)
    const hiLine = sorted[Math.floor(sorted.length * 0.55)]
    const target = Math.max(24, Math.min(200, Math.round(Number(greenSqm || 400) / 40)))
    let guard = 0
    while (out.length < 60 + target && guard++ < 4000) {
      const nx = 0.06 + rnd() * 0.88, ny = 0.06 + rnd() * 0.88
      if (inBuilding(nx, ny, bcx, bcy) || nearFlow(nx, ny, flowPath) || nearDrain(nx, ny, drains)) continue
      if (gridHeightAt(grid, nx, ny) < hiLine && rnd() < 0.7) continue // favour high ground
      let clash = false
      for (let i = Math.max(0, out.length - 40); i < out.length; i++) {
        const dx = out[i].nx - nx, dy = out[i].ny - ny
        if (dx * dx + dy * dy < 0.028 * 0.028) { clash = true; break }
      }
      if (clash) continue
      out.push({ nx, ny, s: 0.7 + rnd() * 0.7 })
    }
    return out
  }, [grid, flowPath, drains, greenSqm, bcx, bcy])

  const dummy = useMemo(() => new THREE.Object3D(), [])
  const palette = useMemo(() => ['#16a34a', '#22c55e', '#15803d', '#4ade80'].map((c) => new THREE.Color(c)), [])

  useEffect(() => {
    if (!trunkRef.current || !crownRef.current || !grid?.length) return
    const rnd = mulberry32(7)
    spots.forEach((t, i) => {
      const h = gridHeightAt(grid, t.nx, t.ny)
      const y = h * M2WORLD
      const x = (t.nx - 0.5) * WORLD, z = (t.ny - 0.5) * WORLD
      dummy.position.set(x, y + 0.25 * t.s, z)
      dummy.scale.setScalar(t.s)
      dummy.rotation.y = rnd() * Math.PI
      dummy.updateMatrix()
      trunkRef.current.setMatrixAt(i, dummy.matrix)
      dummy.position.set(x, y + (0.55 + 0.35) * t.s, z)
      dummy.scale.setScalar(t.s)
      dummy.updateMatrix()
      crownRef.current.setMatrixAt(i, dummy.matrix)
      crownRef.current.setColorAt(i, palette[Math.floor(rnd() * palette.length)])
    })
    trunkRef.current.instanceMatrix.needsUpdate = true
    crownRef.current.instanceMatrix.needsUpdate = true
    if (crownRef.current.instanceColor) crownRef.current.instanceColor.needsUpdate = true
  }, [spots, grid, dummy, palette])

  if (!spots.length) return null
  return (
    <group>
      <instancedMesh ref={trunkRef} args={[null, null, Math.max(spots.length, 1)]} castShadow>
        <cylinderGeometry args={[0.06, 0.09, 0.5, 6]} />
        <meshStandardMaterial color="#78350f" roughness={0.9} />
      </instancedMesh>
      <instancedMesh ref={crownRef} args={[null, null, Math.max(spots.length, 1)]} castShadow>
        <icosahedronGeometry args={[0.38, 1]} />
        <meshStandardMaterial roughness={0.8} metalness={0.05} />
      </instancedMesh>
    </group>
  )
}
