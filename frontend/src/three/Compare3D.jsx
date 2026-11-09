import { useMemo } from 'react'
import { Canvas } from '@react-three/fiber'
import * as THREE from 'three'

/* Production comparison twins: render the stored heightmap grid per project.
   items: [{ id, name, risk, badge, heightmap: { grid, size, cell_m } }]
   Projects without stored terrain show an empty placeholder — never fake terrain. */

function MiniTwin({ grid, risk }) {
  const { geom, waterY, col } = useMemo(() => {
    const size = grid.length
    const g = new THREE.PlaneGeometry(12, 12, size - 1, size - 1)
    g.rotateX(-Math.PI / 2)
    const pos = g.attributes.position
    let mn = 1e9, mx = -1e9
    for (let i = 0; i < pos.count; i++) {
      const h = grid[Math.floor(i / size)][i % size]
      mn = Math.min(mn, h); mx = Math.max(mx, h)
      pos.setY(i, (h - mn) * 0.45)
    }
    const colors = new Float32Array(pos.count * 3)
    const lo = new THREE.Color('#0e7490'), hi = new THREE.Color('#64748b')
    for (let i = 0; i < pos.count; i++) {
      const h = grid[Math.floor(i / size)][i % size]
      const t = (h - mn) / Math.max(1e-6, mx - mn)
      const c = lo.clone().lerp(hi, t)
      colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b
    }
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    g.computeVertexNormals()
    const floodFrac = Math.min(0.85, 0.2 + (Number(risk) || 0) / 130)
    const waterH = mn + (mx - mn) * floodFrac
    const col = (Number(risk) || 0) > 60 ? '#f87171' : '#34d399'
    return { geom: g, waterY: (waterH - mn) * 0.45, col }
  }, [grid, risk])

  return (
    <group>
      <mesh geometry={geom}>
        <meshStandardMaterial vertexColors roughness={0.7} metalness={0.15} />
      </mesh>
      <mesh position={[0, waterY, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[12, 12]} />
        <meshStandardMaterial color="#0ea5e9" transparent opacity={0.4} roughness={0.15} depthWrite={false} />
      </mesh>
      <mesh position={[0, 2.2, 0]}>
        <boxGeometry args={[2.6, 1.6, 2.6]} />
        <meshStandardMaterial color={col} emissive={col} emissiveIntensity={0.35} transparent opacity={0.9} />
      </mesh>
    </group>
  )
}

export default function CompareTwins({ items = [] }) {
  if (!items.length) return null
  return (
    <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
      {items.map((it) => {
        const grid = it.heightmap?.grid
        const hasTerrain = Array.isArray(grid) && grid.length >= 4
        return (
          <div key={it.id} className="glass overflow-hidden">
            <div className="h-[220px]">
              {hasTerrain ? (
                <Canvas dpr={[1, 1.5]} camera={{ position: [10, 8, 10], fov: 45 }}>
                  <color attach="background" args={['#0a1a33']} />
                  <ambientLight intensity={0.7} />
                  <directionalLight position={[8, 12, 6]} intensity={1.6} />
                  <pointLight position={[-6, 5, -6]} intensity={8} color="#22d3ee" distance={24} />
                  <MiniTwin grid={grid} risk={it.risk} />
                </Canvas>
              ) : (
                <div className="h-full grid place-items-center text-center p-6 text-xs text-slate-400">
                  No stored terrain —<br />run Analyze for this project.
                </div>
              )}
            </div>
            <div className="p-3 flex items-center justify-between text-xs">
              <span className="font-bold truncate">{it.name}</span>
              <span className={`font-num font-bold ${(Number(it.risk) || 0) > 60 ? 'text-red-300' : 'text-emerald-300'}`}>
                {it.risk != null ? Number(it.risk).toFixed(1) : '—'}
              </span>
            </div>
          </div>
        )
      })}
    </div>
  )
}
