import { useMemo, useRef, useState, useEffect, useCallback } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { OrbitControls, Html, Stars, Sky, Sparkles, ContactShadows, Float, Cloud, Clouds } from '@react-three/drei'
import * as THREE from 'three'
import { fetchSiteContext, footprintIntersects } from '../lib/osm'
import { sampleRoofColors } from '../lib/roofColor'
import DrainNetwork from './DrainNetwork'
import Trees from './Trees'

/*
 * Advanced FloodShield 3D twin.
 * Props (all new ones optional → backward compatible):
 *   heightmap { grid, flow_path, intersects, outlet, size, cell_m }
 *   dusk, riskScore (0-100 → status chip + water tint),
 *   waterRise (meters of flood forcing → raises water plane + flood tint),
 *   plinthM (meters → lifts the building model),
 *   siteLat, siteLng (map pin → pulls real OpenStreetMap structures + roads),
 *   zones ([{polygon:[{lat,lng}], kind, name}] → user-tagged overlays),
 *   quality 'ultra' | 'high' | 'eco' (initial render quality)
 */

const QUALITY = {
  ultra: { dpr: [1, 2], flowN: 320, rain: 700, sparkles: 90 },
  high: { dpr: [1, 1.5], flowN: 200, rain: 400, sparkles: 55 },
  eco: { dpr: [1, 1], flowN: 110, rain: 0, sparkles: 25 },
}
const M2WORLD = 0.45 // world units per meter of elevation (gentle; plains read flat)

function elevColor(h, min, max, floodH) {
  const t = THREE.MathUtils.clamp((h - min) / Math.max(1e-6, max - min), 0, 1)
  const stops = [
    [0.02, 0.22, 0.38],
    [0.08, 0.55, 0.62],
    [0.45, 0.72, 0.60],
    [0.42, 0.48, 0.60],
    [0.92, 0.95, 1.0],
  ]
  const seg = Math.min(stops.length - 2, Math.floor(t * (stops.length - 1)))
  const f = t * (stops.length - 1) - seg
  const a = stops[seg], b = stops[seg + 1]
  const c = a.map((v, i) => v + (b[i] - v) * f)
  // Flood tint hugs the waterline: only ground at/below it turns blue, so flat
  // dry sites keep their earth tones instead of washing out.
  if (h < floodH + 0.25) {
    const k = THREE.MathUtils.clamp((floodH + 0.25 - h) / 1.2, 0, 0.45)
    c[0] = c[0] * (1 - k) + 0.05 * k
    c[1] = c[1] * (1 - k) + 0.65 * k
    c[2] = c[2] * (1 - k) + 0.9 * k
  }
  return new THREE.Color(c[0], c[1], c[2])
}

/* ------------------------------- TERRAIN ------------------------------- */
function Terrain({ grid, riseM }) {
  const { geom, wire, waterY } = useMemo(() => {
    const size = grid.length || 64
    const WORLD = 24
    const g = new THREE.PlaneGeometry(WORLD, WORLD, size - 1, size - 1)
    g.rotateX(-Math.PI / 2)
    const pos = g.attributes.position
    let mn = 1e9, mx = -1e9
    const heights = []
    for (let i = 0; i < pos.count; i++) {
      const ix = i % size, iz = Math.floor(i / size)
      const raw = grid[iz]?.[ix]
      const h = Number.isFinite(raw) ? raw : 0
      mn = Math.min(mn, h); mx = Math.max(mx, h)
      heights.push(h)
      pos.setY(i, h * M2WORLD)
    }
    const sorted = [...heights].sort((a, b) => a - b)
    const waterH = (sorted[Math.floor(sorted.length * 0.32)] ?? mn + 1.5) + riseM
    const colors = new Float32Array(pos.count * 3)
    for (let i = 0; i < pos.count; i++) {
      const ix = i % size, iz = Math.floor(i / size)
      const c = elevColor(grid[iz][ix], mn, mx, waterH)
      colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b
    }
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    g.computeVertexNormals()
    return { geom: g, wire: g.clone(), waterY: waterH * M2WORLD }
  }, [grid, riseM])

  return (
    <group>
      <mesh geometry={geom} receiveShadow castShadow>
        <meshStandardMaterial vertexColors roughness={0.62} metalness={0.22} envMapIntensity={0.7} />
      </mesh>
      <mesh geometry={wire} position={[0, 0.02, 0]}>
        <meshBasicMaterial wireframe transparent opacity={0.07} color="#a5f3fc" depthWrite={false} />
      </mesh>
      <RealisticWater y={waterY} />
      <mesh position={[0, -3.4, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[17, 64]} />
        <meshBasicMaterial color="#0ea5e9" transparent opacity={0.06} depthWrite={false} />
      </mesh>
    </group>
  )
}

/* ------------------------- REALISTIC WATER SHADER ------------------------- */
const WaterShaderMaterial = {
  uniforms: {
    uTime: { value: 0 },
    uDeepColor: { value: new THREE.Color('#0b3d63') },
    uShallowColor: { value: new THREE.Color('#2fd6e8') },
    uSkyColor: { value: new THREE.Color('#bfe9ff') },
    uOpacity: { value: 0.72 },
    uFlowDir: { value: new THREE.Vector2(0.6, 0.4) },
  },
  vertex: /* glsl */`
    uniform float uTime;
    varying vec3 vWorldPos;
    varying vec3 vNormalW;
    varying float vWaveH;
    // Sum of gerstner-like waves (displacement only; cheap & fast)
    float wave(vec2 p, vec2 dir, float freq, float speed, float amp) {
      return sin(dot(p, dir) * freq + uTime * speed) * amp;
    }
    void main() {
      vec3 pos = position;
      vec2 p = pos.xz;
      float h = 0.0;
      h += wave(p, normalize(vec2(1.0, 0.6)), 1.4, 1.4, 0.085);
      h += wave(p, normalize(vec2(-0.7, 1.0)), 2.3, 2.1, 0.05);
      h += wave(p, normalize(vec2(0.3, -1.0)), 4.1, 2.8, 0.028);
      pos.y += h;
      vWaveH = h;
      // approximate normal via partial derivatives of biggest wave
      float e = 0.08;
      float hx = wave(p + vec2(e, 0.0), normalize(vec2(1.0, 0.6)), 1.4, 1.4, 0.085) - wave(p - vec2(e, 0.0), normalize(vec2(1.0, 0.6)), 1.4, 1.4, 0.085);
      float hz = wave(p + vec2(0.0, e), normalize(vec2(1.0, 0.6)), 1.4, 1.4, 0.085) - wave(p - vec2(0.0, e), normalize(vec2(1.0, 0.6)), 1.4, 1.4, 0.085);
      vNormalW = normalize(vec3(-hx / (2.0 * e), 1.0, -hz / (2.0 * e)));
      vec4 wp = modelMatrix * vec4(pos, 1.0);
      vWorldPos = wp.xyz;
      gl_Position = projectionMatrix * viewMatrix * wp;
    }
  `,
  fragment: /* glsl */`
    uniform float uTime;
    uniform vec3 uDeepColor;
    uniform vec3 uShallowColor;
    uniform vec3 uSkyColor;
    uniform float uOpacity;
    uniform vec2 uFlowDir;
    varying vec3 vWorldPos;
    varying vec3 vNormalW;
    varying float vWaveH;
    // cheap hash noise
    float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    float noise(vec2 p) {
      vec2 i = floor(p), f = fract(p);
      vec2 u = f * f * (3.0 - 2.0 * f);
      return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x),
                 mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
    }
    void main() {
      vec3 viewDir = normalize(cameraPosition - vWorldPos);
      vec3 n = normalize(vNormalW);
      // ripple detail perturbs normal
      float rip = noise(vWorldPos.xz * 2.4 + uFlowDir * uTime * 0.9)
                + noise(vWorldPos.xz * 5.5 - uFlowDir * uTime * 1.7) * 0.5;
      n = normalize(n + vec3((rip - 0.75) * 0.35, 0.0, (rip - 0.75) * 0.35));
      // fresnel: sky reflection at grazing angles
      float fresnel = pow(1.0 - max(dot(viewDir, n), 0.0), 3.0);
      // depth-ish tint from wave height (crest = shallower/foamier)
      float crest = smoothstep(0.05, 0.14, vWaveH);
      vec3 body = mix(uDeepColor, uShallowColor, clamp(crest + rip * 0.25, 0.0, 1.0));
      // sun specular
      vec3 sunDir = normalize(vec3(0.55, 0.75, 0.35));
      vec3 hv = normalize(sunDir + viewDir);
      float spec = pow(max(dot(n, hv), 0.0), 220.0) * 2.4;
      // foam: crest bands + noise breakup
      float foamBand = smoothstep(0.09, 0.13, vWaveH) * (0.55 + 0.45 * noise(vWorldPos.xz * 9.0 + uTime * 0.8));
      vec3 col = mix(body, uSkyColor, fresnel * 0.75);
      col += vec3(spec);
      col = mix(col, vec3(0.95, 0.99, 1.0), clamp(foamBand, 0.0, 0.85));
      float alpha = clamp(uOpacity + fresnel * 0.15 + foamBand * 0.1, 0.0, 0.97);
      gl_FragColor = vec4(col, alpha);
    }
  `,
}

function RealisticWater({ y, size = 24 }) {
  const mat = useRef()
  const geom = useMemo(() => new THREE.PlaneGeometry(size, size, 128, 128), [size])
  const uniforms = useMemo(() => THREE.UniformsUtils.clone({
    uTime: { value: 0 },
    uDeepColor: { value: new THREE.Color('#0b3d63') },
    uShallowColor: { value: new THREE.Color('#2fd6e8') },
    uSkyColor: { value: new THREE.Color('#bfe9ff') },
    uOpacity: { value: 0.72 },
    uFlowDir: { value: new THREE.Vector2(0.6, 0.4) },
  }), [])
  useEffect(() => () => geom.dispose(), [geom])
  useFrame(({ clock }) => {
    if (mat.current) mat.current.uniforms.uTime.value = clock.getElapsedTime()
  })
  return (
    <mesh geometry={geom} position={[0, y, 0]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={2}>
      <shaderMaterial ref={mat} transparent depthWrite={false} side={THREE.DoubleSide}
        uniforms={uniforms}
        vertexShader={WaterShaderMaterial.vertex}
        fragmentShader={WaterShaderMaterial.fragment} />
    </mesh>
  )
}

function WaterPlane({ y }) {
  const ref = useRef()
  const ref2 = useRef()
  useFrame(({ clock }) => {
    const t = clock.getElapsedTime()
    if (ref.current) {
      ref.current.position.y = y + Math.sin(t * 0.9) * 0.07
      ref.current.material.opacity = 0.32 + Math.sin(t * 1.4) * 0.05
    }
    if (ref2.current) {
      ref2.current.position.y = y + 0.06 + Math.cos(t * 0.7) * 0.05
      ref2.current.material.opacity = 0.12 + Math.cos(t * 1.1) * 0.03
    }
  })
  return (
    <group>
      <mesh ref={ref} position={[0, y, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[24, 24, 1, 1]} />
        <meshPhysicalMaterial color="#0ea5e9" transparent opacity={0.34} roughness={0.08}
          metalness={0.35} clearcoat={1} clearcoatRoughness={0.12} depthWrite={false} />
      </mesh>
      <mesh ref={ref2} position={[0, y + 0.06, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[24, 24, 32, 32]} />
        <meshBasicMaterial color="#67e8f9" wireframe transparent opacity={0.12} depthWrite={false} />
      </mesh>
    </group>
  )
}

/* ---------------------------- FLOW TUBE + PARTICLES ---------------------------- */
function worldFromPath(path) {
  // path heights must be site-relative (see normPath) — never absolute DEM meters.
  // Non-finite points are dropped: one bad sample must not kill the whole tube.
  return (path || [])
    .filter((p) => Number.isFinite(p?.x) && Number.isFinite(p?.y) && Number.isFinite(p?.h))
    .map((p) => new THREE.Vector3((p.x - 0.5) * 24, p.h * M2WORLD + 0.42, (p.y - 0.5) * 24))
}

function FlowTube({ path }) {
  const tube = useMemo(() => {
    if (!path?.length) return null
    const pts = worldFromPath(path)
    if (pts.length < 2) return null
    return { geo: new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 120, 0.09, 8, false) }
  }, [path])
  const ref = useRef()
  useFrame(({ clock }) => {
    if (ref.current) ref.current.emissiveIntensity = 1.4 + Math.sin(clock.getElapsedTime() * 3) * 0.5
  })
  if (!tube) return null
  return (
    <mesh geometry={tube.geo}>
      <meshStandardMaterial ref={ref} color="#22d3ee" emissive="#0ea5e9"
        emissiveIntensity={1.6} transparent opacity={0.85} roughness={0.2} />
    </mesh>
  )
}

function FlowParticles({ path, count = 320 }) {
  const ref = useRef()
  const curve = useMemo(() => {
    if (!path?.length) return null
    const pts = worldFromPath(path)
    if (pts.length < 2) return null
    return new THREE.CatmullRomCurve3(pts)
  }, [path])
  const dummy = useMemo(() => new THREE.Object3D(), [])
  const tmp = useMemo(() => new THREE.Vector3(), [])
  useFrame(({ clock }) => {
    if (!ref.current || !curve) return
    const t = clock.getElapsedTime()
    for (let i = 0; i < count; i++) {
      const f = ((i / count) + t * 0.09) % 1
      curve.getPointAt(f, tmp)
      dummy.position.set(tmp.x, tmp.y + Math.sin(t * 3 + i * 1.7) * 0.09, tmp.z)
      dummy.scale.setScalar(Math.max(0.05, 0.1 + 0.09 * (0.5 + 0.5 * Math.sin(t * 5 + i))))
      dummy.updateMatrix()
      ref.current.setMatrixAt(i, dummy.matrix)
    }
    ref.current.instanceMatrix.needsUpdate = true
  })
  if (!curve) return null
  return (
    <instancedMesh ref={ref} args={[null, null, Math.max(count, 1)]} frustumCulled={false}>
      <sphereGeometry args={[1, 10, 10]} />
      <meshStandardMaterial color="#a5f3fc" emissive="#22d3ee" emissiveIntensity={2.2} transparent opacity={0.95} />
    </instancedMesh>
  )
}

function OutletBeacon({ outlet }) {
  const ref = useRef()
  useFrame(({ clock }) => {
    const t = clock.getElapsedTime()
    if (ref.current) {
      ref.current.position.y = 1.2 + Math.sin(t * 2) * 0.35
      ref.current.scale.setScalar(1 + Math.sin(t * 3) * 0.12)
    }
  })
  if (!outlet) return null
  const x = (outlet.x - 0.5) * 24, z = (outlet.y - 0.5) * 24
  return (
    <Float speed={2} floatIntensity={1.2}>
      <mesh ref={ref} position={[x, 1.2, z]}>
        <octahedronGeometry args={[0.42]} />
        <meshStandardMaterial color="#f0abfc" emissive="#d946ef" emissiveIntensity={2.4} />
      </mesh>
      <Html position={[x, 2.1, z]} center zIndexRange={[5, 0]}>
        <div className="text-[10px] px-2 py-0.5 rounded-full font-bold whitespace-nowrap bg-fuchsia-500/90 text-white shadow-[0_0_16px_#d946ef]">OUTLET</div>
      </Html>
    </Float>
  )
}

/* -------------------------------- BUILDING -------------------------------- */
/* Proposed design — sized from the project's real footprint_sqm so the block
   differs per site (it is YOUR design, not the surroundings; those come from
   the area map + registry drains). */
function Building({ intersects, height = 2.4, liftY = 0, footprintSqm = 800, cx = 0.475, cy = 0.475 }) {
  const ring = useRef()
  const glow = useRef()
  const size = Math.max(2, Math.min(9, 5 * Math.sqrt(Math.max(50, Number(footprintSqm) || 800) / 800)))
  const c = size / 2
  useFrame(({ clock }) => {
    const t = clock.getElapsedTime()
    if (ring.current) {
      const s = 1 + ((t * 0.7) % 1) * 0.9
      ring.current.scale.set(s, s, s)
      ring.current.material.opacity = 0.7 * (1 - ((t * 0.7) % 1))
    }
    if (glow.current) glow.current.emissiveIntensity = (intersects ? 0.9 : 0.45) + Math.sin(t * 2.4) * 0.2
  })
  const gx = (cx - 0.5) * 24 - 2.5, gz = (cy - 0.5) * 24 - 2.5
  return (
    <group position={[gx, liftY, gz]}>
      {[-2, 2].map((dx) => [-2, 2].map((dz) => (
        <mesh key={`${dx}${dz}`} position={[2.5 + (dx * size) / 5, 0.35, 2.5 + (dz * size) / 5]}>
          <cylinderGeometry args={[0.14, 0.14, 0.9, 12]} />
          <meshStandardMaterial color="#94a3b8" roughness={0.4} metalness={0.6} />
        </mesh>
      )))}
      <mesh position={[2.5, height / 2 + 0.7, 2.5]} castShadow>
        <boxGeometry args={[size, height, size]} />
        <meshPhysicalMaterial ref={glow} color={intersects ? '#f87171' : '#34d399'}
          emissive={intersects ? '#7f1d1d' : '#064e3b'} emissiveIntensity={0.6}
          transparent opacity={0.88} roughness={0.15} metalness={0.1} clearcoat={1} />
      </mesh>
      {[0.2, 0.5, 0.8].map((f) => (
        <mesh key={f} position={[2.5, 0.7 + height * f, 2.51]}>
          <boxGeometry args={[size + 0.02, 0.03, size + 0.02]} />
          <meshBasicMaterial color="#ffffff" transparent opacity={0.35} />
        </mesh>
      ))}
      <mesh position={[2.5, height + 0.78, 2.5]} castShadow>
        <boxGeometry args={[size + 0.5, 0.14, size + 0.5]} />
        <meshStandardMaterial color="#e2e8f0" roughness={0.3} metalness={0.4} />
      </mesh>
      <mesh position={[2.5, height + 0.9, 2.5]}>
        <boxGeometry args={[size - 0.6, 0.1, 1.4]} />
        <meshStandardMaterial color="#22c55e" emissive="#14532d" emissiveIntensity={0.6} />
      </mesh>
      <mesh ref={ring} position={[2.5, 0.15 - liftY, 2.5]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[c + 1.1, c + 1.5, 48]} />
        <meshBasicMaterial color={intersects ? '#ef4444' : '#10b981'} transparent opacity={0.6} side={THREE.DoubleSide} depthWrite={false} />
      </mesh>
      <Html position={[2.5, height + 1.7, 2.5]} center zIndexRange={[5, 0]}>
        <div className={`text-[10px] px-2 py-0.5 rounded-full font-extrabold whitespace-nowrap backdrop-blur-md border border-white/20 ${intersects ? 'bg-red-500/90 shadow-[0_0_20px_#ef4444]' : 'bg-emerald-500/90 shadow-[0_0_20px_#10b981]'} text-white`}>
          {intersects ? `⛔ PROPOSED · ${Math.round(Number(footprintSqm) || 800)} m² · BLOCKS FLOW` : `✓ PROPOSED · ${Math.round(Number(footprintSqm) || 800)} m² · CLEAR`}
        </div>
      </Html>
    </group>
  )
}

/* ---------------------------------- RAIN ---------------------------------- */
function Rain({ count = 700, active }) {
  const ref = useRef()
  const { pos, vel } = useMemo(() => {
    const pos = new Float32Array(Math.max(count, 1) * 3)
    const vel = new Float32Array(Math.max(count, 1))
    for (let i = 0; i < Math.max(count, 1); i++) {
      pos[i * 3] = (Math.random() - 0.5) * 26
      pos[i * 3 + 1] = Math.random() * 14
      pos[i * 3 + 2] = (Math.random() - 0.5) * 26
      vel[i] = 6 + Math.random() * 6
    }
    return { pos, vel }
  }, [count])
  useFrame((_, dt) => {
    if (!ref.current || !active || !count) return
    const p = ref.current.geometry.attributes.position
    const d = Math.min(dt, 0.05)
    for (let i = 0; i < count; i++) {
      let y = p.getY(i) - vel[i] * d
      if (y < -2.5) y = 14
      p.setY(i, y)
    }
    p.needsUpdate = true
  })
  if (!active || !count) return null
  return (
    <points ref={ref}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[pos, 3]} />
      </bufferGeometry>
      <pointsMaterial color="#7dd3fc" size={0.09} transparent opacity={0.75} sizeAttenuation depthWrite={false} />
    </points>
  )
}

/* ---------------------------- STORM CLOUDS + LIGHTNING ---------------------------- */
function StormClouds({ active, intensity = 1 }) {
  const group = useRef()
  useFrame(({ clock }) => {
    if (group.current) group.current.rotation.y = clock.getElapsedTime() * 0.008
  })
  if (!active) return null
  return (
    <group ref={group} position={[0, 11, 0]}>
      <Clouds material={THREE.MeshBasicMaterial} limit={200}>
        <Cloud seed={7} segments={26} volume={9} opacity={0.5 * intensity} fade={14} speed={0.25} growth={5} color="#334155" position={[-6, 0, -4]} />
        <Cloud seed={19} segments={22} volume={8} opacity={0.45 * intensity} fade={12} speed={0.3} growth={4} color="#475569" position={[7, 1.5, 3]} />
        <Cloud seed={33} segments={18} volume={6} opacity={0.4 * intensity} fade={10} speed={0.35} growth={4} color="#1e293b" position={[1, 2.5, -7]} />
      </Clouds>
    </group>
  )
}

function Lightning({ active, dusk }) {
  const light = useRef()
  const bolt = useRef()
  const state = useRef({ next: 2.5, flash: 0, boltT: 0 })
  const boltGeom = useMemo(() => {
    // jagged polyline bolt
    const pts = []
    let x = 0, y = 12, z = 0
    for (let i = 0; i < 14; i++) {
      pts.push(new THREE.Vector3(x, y, z))
      x += (Math.random() - 0.5) * 1.6
      z += (Math.random() - 0.5) * 1.6
      y -= 0.95
    }
    return new THREE.BufferGeometry().setFromPoints(pts)
  }, [])
  useFrame(({ clock }, dt) => {
    const t = clock.getElapsedTime()
    const s = state.current
    if (!active) return
    if (t > s.next) {
      s.flash = 1
      s.boltT = t
      s.next = t + 2.5 + Math.random() * 5
      if (bolt.current) {
        bolt.current.position.set((Math.random() - 0.5) * 16, 0, (Math.random() - 0.5) * 16)
      }
    }
    s.flash = Math.max(0, s.flash - dt * 5)
    const flicker = s.flash * (0.6 + 0.4 * Math.sin(t * 90))
    if (light.current) light.current.intensity = flicker * 260
    if (bolt.current) bolt.current.material.opacity = Math.max(0, flicker - 0.08)
  })
  if (!active) return null
  return (
    <group>
      <pointLight ref={light} position={[0, 10, 0]} color={dusk ? '#c4b5fd' : '#e0f2fe'} intensity={0} distance={60} decay={1.6} />
      <line ref={bolt} geometry={boltGeom}>
        <lineBasicMaterial color="#f0f9ff" transparent opacity={0} linewidth={2} depthWrite={false} />
      </line>
    </group>
  )
}

/* ---------------------------- CINEMATIC CAMERA TOUR ---------------------------- */
function CameraTour({ playing, onDone, focus }) {
  const { camera, controls } = useThree()
  const anim = useRef({ t: 0, seg: 0 })
  // waypoints: [position, lookAt, dwellSeconds]
  const tour = useMemo(() => {
    const f = focus || new THREE.Vector3(-1.7, 1.5, -1.7) // building
    return [
      [new THREE.Vector3(16, 12, 16), new THREE.Vector3(0, 0, 0), 2.5],      // wide establishing
      [new THREE.Vector3(9, 3.4, 9), new THREE.Vector3(0, -0.5, 0), 3],       // low over water
      [new THREE.Vector3(f.x + 6, 4.2, f.z + 6), f, 3],                       // approach building
      [new THREE.Vector3(f.x - 1, 2.2, f.z + 7), f, 2.5],                     // flood-level close-up
      [new THREE.Vector3(-12, 9, -12), new THREE.Vector3(2, 0, 2), 3],        // outlet side
      [new THREE.Vector3(15, 12, 15), new THREE.Vector3(0, 0, 0), 2],         // return
    ]
  }, [focus])
  useEffect(() => {
    if (playing) anim.current = { t: 0, seg: 0 }
  }, [playing])
  useFrame((_, dt) => {
    if (!playing) return
    const a = anim.current
    a.t += dt
    const segDur = tour[a.seg]?.[2] ?? 2
    const k = Math.min(1, a.t / segDur)
    const smooth = k * k * (3 - 2 * k)
    const [p0, l0] = tour[a.seg]
    const [p1, l1] = tour[Math.min(a.seg + 1, tour.length - 1)]
    camera.position.lerpVectors(p0, p1, smooth)
    const look = new THREE.Vector3().lerpVectors(l0, l1, smooth)
    camera.lookAt(look)
    if (controls) { controls.target.copy(look); controls.update() }
    if (k >= 1) {
      a.seg += 1
      a.t = 0
      if (a.seg >= tour.length - 1) { onDone?.() }
    }
  })
  return null
}

function FpsProbe({ onFps }) {
  const acc = useRef({ n: 0, last: 0 })
  useFrame(({ clock }) => {
    const t = clock.getElapsedTime()
    acc.current.n += 1
    if (t - acc.current.last >= 1) {
      onFps(acc.current.n)
      acc.current.n = 0
      acc.current.last = t
    }
  })
  return null
}

/* --------------------- REAL SITE CONTEXT (OSM + zones) --------------------- */
const ZONE3D = { building: '#f87171', parking: '#fb923c', road: '#facc15', open_space: '#94a3b8', drainage: '#22d3ee', green: '#34d399' }

function gridHeightAt(grid, nx, ny) {
  const n = grid.length
  if (!n) return 0 // site-relative grid: base sits at 0
  const ix = Math.max(0, Math.min(n - 1, Math.round(nx * (n - 1))))
  const iz = Math.max(0, Math.min(n - 1, Math.round(ny * (n - 1))))
  const v = grid[iz]?.[ix]
  return Number.isFinite(v) ? v : 0
}

/* Your-site boundary: a dashed amber survey rectangle from site_area_sqm,
   centered on the pin. Everything inside is YOUR vacant plot; towers outside
   are real neighbours (OSM), not your site. */
function SiteBoundary({ siteAreaM2, siteLat, grid }) {
  const data = useMemo(() => {
    const area = Number(siteAreaM2)
    if (!area || area <= 0 || !grid?.length) return null
    const sideM = Math.sqrt(area)
    const latM = 111320, lngM = 111320 * Math.cos((Number(siteLat) * Math.PI) / 180)
    const hx = sideM / 2 / lngM / 0.01, hy = sideM / 2 / latM / 0.01
    const corners = [
      [0.5 - hx, 0.5 - hy], [0.5 + hx, 0.5 - hy],
      [0.5 + hx, 0.5 + hy], [0.5 - hx, 0.5 + hy],
    ]
    let top = 0
    for (const [nx, ny] of [...corners, [0.5, 0.5]]) top = Math.max(top, gridHeightAt(grid, nx, ny))
    const y = top * M2WORLD + 0.3
    const pts = corners.map(([nx, ny]) => new THREE.Vector3((nx - 0.5) * 24, y, (ny - 0.5) * 24))
    const geo = new THREE.BufferGeometry().setFromPoints([...pts, pts[0]])
    return { geo, y, sideM: Math.round(sideM) }
  }, [siteAreaM2, siteLat, grid])
  const loopRef = useRef(null)
  useEffect(() => () => data?.geo.dispose(), [data])
  useEffect(() => { loopRef.current?.computeLineDistances() }, [data])
  if (!data) return null
  const labelX = 0, labelZ = 0
  return (
    <group>
      <lineLoop ref={loopRef} geometry={data.geo}>
        <lineDashedMaterial color="#fbbf24" dashSize={0.5} gapSize={0.3} transparent opacity={0.95} />
      </lineLoop>
      <Html position={[labelX, data.y + 1.1, labelZ]} center zIndexRange={[5, 0]}>
        <div className="text-[10px] px-2 py-0.5 rounded-full font-extrabold whitespace-nowrap bg-amber-400/90 text-[#0b1526] shadow-[0_0_14px_#fbbf24]">
          YOUR SITE · {data.sideM}×{data.sideM} m
        </div>
      </Html>
    </group>
  )
}

/* Real neighbouring structures as extruded footprints, seated on the terrain.
   Red = intersects the traced flow path. Otherwise roofs wear their TRUE
   satellite-sampled color (terracotta / concrete / sheet metal) with shaded
   walls — the block reads as the actual building, not a grey placeholder. */
function RealBuildings({ buildings, flowPath, grid, siteLat, siteLng }) {
  const [cols, setCols] = useState([])
  useEffect(() => {
    let dead = false
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), 30000)
    setCols([])
    if (!buildings?.length || siteLat == null) return () => { dead = true; clearTimeout(timer); ctl.abort() }
    sampleRoofColors(buildings, siteLat, siteLng, ctl.signal)
      .then((c) => { if (!dead) setCols(c) })
      .catch(() => { if (!dead) setCols([]) })
    return () => { dead = true; clearTimeout(timer); ctl.abort() }
  }, [buildings, siteLat, siteLng])
  const items = useMemo(() => {
    if (!buildings?.length || !grid?.length) return []
    const out = []
    for (let bi = 0; bi < buildings.length; bi++) {
      const b = buildings[bi]
      if (!b.poly || b.poly.length < 4) continue
      try {
        const shape = new THREE.Shape(b.poly.map(([nx, ny]) => new THREE.Vector2((nx - 0.5) * 24, -((ny - 0.5) * 24))))
        const hM = Math.max(2, Math.min(60, Number(b.heightM) || 8))
        const geo = new THREE.ExtrudeGeometry(shape, { depth: hM * M2WORLD, bevelEnabled: false })
        geo.rotateX(-Math.PI / 2)
        let h = 0, c = 0
        for (const [nx, ny] of b.poly) { h += gridHeightAt(grid, nx, ny); c++ }
        const blocking = footprintIntersects(b.poly, flowPath)
        const sampled = cols[bi]
        // Honest brightness jitter when no tile was readable: same slate family,
        // deterministic per building — variation, never invented colors.
        const hv = 0.82 + (((bi * 37) % 20) / 20) * 0.36
        const roofMat = new THREE.MeshStandardMaterial({
          color: blocking ? new THREE.Color('#f87171') : new THREE.Color(...(sampled?.roof || [0.8 * hv, 0.84 * hv, 0.89 * hv])),
          emissive: blocking ? new THREE.Color('#7f1d1d') : new THREE.Color('#000000'),
          emissiveIntensity: blocking ? 0.7 : 0,
          roughness: 0.85, metalness: 0.05, transparent: true, opacity: 0.98,
        })
        const wallMat = new THREE.MeshStandardMaterial({
          color: blocking ? new THREE.Color('#b91c1c') : new THREE.Color(...(sampled?.wall || [0.55 * hv, 0.6 * hv, 0.66 * hv])),
          emissive: blocking ? new THREE.Color('#450a0a') : new THREE.Color('#000000'),
          emissiveIntensity: blocking ? 0.5 : 0,
          roughness: 0.8, metalness: 0.05, transparent: true, opacity: 0.98,
        })
        out.push({ geo, roofMat, wallMat, y: (c ? h / c : 0) * M2WORLD, blocking })
      } catch { /* skip malformed ring */ }
    }
    return out
  }, [buildings, flowPath, grid, cols])
  useEffect(() => () => {
    items.forEach((i) => { i.geo.dispose(); i.roofMat.dispose(); i.wallMat.dispose() })
  }, [items])
  if (!items.length) return null
  return (
    <group>
      {items.map((it, i) => (
        // ExtrudeGeometry group 0 = caps (roof), group 1 = side walls
        <mesh key={i} geometry={it.geo} material={[it.roofMat, it.wallMat]} position={[0, it.y, 0]} castShadow />
      ))}
    </group>
  )
}

/* Roads as draped asphalt ribbons (not hairlines) so streets read correctly. */
function Roads({ roads, grid }) {
  const geo = useMemo(() => {
    if (!roads?.length || !grid?.length) return null
    const W = 0.13 // ≈6 m ribbon
    const verts = []
    const idx = []
    let vi = 0
    for (const line of roads) {
      const pts = line.map(([nx, ny]) => new THREE.Vector3(
        (nx - 0.5) * 24, gridHeightAt(grid, nx, ny) * M2WORLD + 0.1, (ny - 0.5) * 24))
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i], b = pts[i + 1]
        const dir = new THREE.Vector3().subVectors(b, a)
        dir.y = 0
        if (dir.lengthSq() < 1e-8) continue
        dir.normalize()
        const px = -dir.z * W / 2, pz = dir.x * W / 2
        verts.push(a.x + px, a.y, a.z + pz, a.x - px, a.y, a.z - pz,
          b.x + px, b.y, b.z + pz, b.x - px, b.y, b.z - pz)
        idx.push(vi, vi + 2, vi + 1, vi + 1, vi + 2, vi + 3)
        vi += 4
      }
    }
    if (!idx.length) return null
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3))
    g.setIndex(idx)
    g.computeVertexNormals()
    return g
  }, [roads, grid])
  useEffect(() => () => geo?.dispose(), [geo])
  if (!geo) return null
  return (
    <mesh geometry={geo} renderOrder={1}>
      <meshBasicMaterial color="#3b4554" transparent opacity={0.92} side={THREE.DoubleSide} depthWrite={false} />
    </mesh>
  )
}

/* Real water bodies + parks from OpenStreetMap, seated on the terrain. */
function WaterBodies({ rings, grid }) {
  const items = useMemo(() => {
    if (!rings?.length || !grid?.length) return []
    const out = []
    for (const ring of rings) {
      if (!ring || ring.length < 4) continue
      try {
        const shape = new THREE.Shape(ring.map(([nx, ny]) => new THREE.Vector2((nx - 0.5) * 24, -((ny - 0.5) * 24))))
        const geo = new THREE.ShapeGeometry(shape)
        geo.rotateX(-Math.PI / 2)
        let mn = Infinity
        for (const [nx, ny] of ring) mn = Math.min(mn, gridHeightAt(grid, nx, ny))
        out.push({ geo, y: (Number.isFinite(mn) ? mn : 0) * M2WORLD + 0.16 })
      } catch { /* skip malformed ring */ }
    }
    return out
  }, [rings, grid])
  useEffect(() => () => { items.forEach((i) => i.geo.dispose()) }, [items])
  if (!items.length) return null
  return (
    <group>
      {items.map((it, i) => (
        <mesh key={i} geometry={it.geo} position={[0, it.y, 0]} renderOrder={1}>
          <meshStandardMaterial color="#0284c7" emissive="#0c4a6e" emissiveIntensity={0.5}
            transparent opacity={0.82} roughness={0.08} metalness={0.35} depthWrite={false} />
        </mesh>
      ))}
    </group>
  )
}

function ParkPatches({ rings, grid }) {
  const items = useMemo(() => {
    if (!rings?.length || !grid?.length) return []
    const out = []
    for (const ring of rings) {
      if (!ring || ring.length < 4) continue
      try {
        const shape = new THREE.Shape(ring.map(([nx, ny]) => new THREE.Vector2((nx - 0.5) * 24, -((ny - 0.5) * 24))))
        const geo = new THREE.ShapeGeometry(shape)
        geo.rotateX(-Math.PI / 2)
        let h = 0, c = 0
        for (const [nx, ny] of ring) { h += gridHeightAt(grid, nx, ny); c++ }
        out.push({ geo, y: (c ? h / c : 0) * M2WORLD + 0.09 })
      } catch { /* skip malformed ring */ }
    }
    return out
  }, [rings, grid])
  useEffect(() => () => { items.forEach((i) => i.geo.dispose()) }, [items])
  if (!items.length) return null
  return (
    <group>
      {items.map((it, i) => (
        <mesh key={i} geometry={it.geo} position={[0, it.y, 0]} renderOrder={1}>
          <meshStandardMaterial color="#16a34a" transparent opacity={0.45} roughness={0.9} depthWrite={false} />
        </mesh>
      ))}
    </group>
  )
}

/* User-tagged site zones: building zones extrude as amber blocks (your design),
   other kinds draw as ground outlines in kind colors. */
function ZoneOverlays({ zones, siteLat, siteLng, grid, flowPath }) {
  const items = useMemo(() => {
    if (!zones?.length || !grid?.length || siteLat == null) return []
    const out = []
    for (const z of zones) {
      const norm = ((z.polygon || []).map((p) => {
        const la = Array.isArray(p) ? p[0] : p.lat
        const ln = Array.isArray(p) ? p[1] : p.lng
        if (!Number.isFinite(la) || !Number.isFinite(ln)) return null
        return [(ln - (siteLng - 0.005)) / 0.01, (la - (siteLat - 0.005)) / 0.01]
      }).filter(Boolean))
      if (norm.length < 3) continue
      if (z.kind === 'building') {
        try {
          const shape = new THREE.Shape(norm.map(([nx, ny]) => new THREE.Vector2((nx - 0.5) * 24, -((ny - 0.5) * 24))))
          let h = 0, c = 0
          for (const [nx, ny] of norm) { h += gridHeightAt(grid, nx, ny); c++ }
          const baseY = (c ? h / c : 0) * M2WORLD
          const geo = new THREE.ExtrudeGeometry(shape, { depth: 5.5, bevelEnabled: false })
          geo.rotateX(-Math.PI / 2)
          out.push({ type: 'block', geo, y: baseY, color: '#fbbf24', blocking: footprintIntersects(norm, flowPath), name: z.name })
        } catch { /* skip malformed ring */ }
      } else {
        const pts = norm.map(([nx, ny]) => new THREE.Vector3(
          (nx - 0.5) * 24, gridHeightAt(grid, nx, ny) * M2WORLD + 0.2, (ny - 0.5) * 24))
        pts.push(pts[0].clone())
        out.push({ type: 'line', geo: new THREE.BufferGeometry().setFromPoints(pts), color: ZONE3D[z.kind] || '#94a3b8' })
      }
    }
    return out
  }, [zones, siteLat, siteLng, grid, flowPath])
  useEffect(() => () => { items.forEach((i) => i.geo.dispose()) }, [items])
  if (!items.length) return null
  return (
    <group>
      {items.map((it, i) => it.type === 'block' ? (
        <mesh key={i} geometry={it.geo} position={[0, it.y, 0]} castShadow>
          <meshStandardMaterial color={it.blocking ? '#f87171' : '#fbbf24'}
            emissive={it.blocking ? '#7f1d1d' : '#451a03'} emissiveIntensity={0.55}
            roughness={0.5} metalness={0.15} transparent opacity={0.95} />
        </mesh>
      ) : (
        <line key={i} geometry={it.geo}>
          <lineBasicMaterial color={it.color} transparent opacity={0.95} />
        </line>
      ))}
    </group>
  )
}

/* ------------------------------ MAIN COMPONENT ------------------------------ */
export default function Terrain3D({ heightmap, dusk, riskScore = null, waterRise = 0, plinthM = 0.3, siteLat = null, siteLng = null, zones = [], quality: qualityProp = 'ultra', drains = [], inlets = [], surchargedIds = [], footprintSqm = 800, greenSqm = 400, buildingCx = 0.475, buildingCy = 0.475, siteAreaM2 = null }) {
  const [snap, setSnap] = useState('')
  const [spin, setSpin] = useState(true)
  const [rain, setRain] = useState(true)
  const [storm, setStorm] = useState(true)
  const [touring, setTouring] = useState(false)
  const [simPlaying, setSimPlaying] = useState(false)
  const [simT, setSimT] = useState(0) // 0..1 flood timeline
  const [q, setQ] = useState(QUALITY[qualityProp] ? qualityProp : 'ultra')
  const [fps, setFps] = useState(0)
  const qs = QUALITY[q]
  const [showReal, setShowReal] = useState(true)
  const [showDrains, setShowDrains] = useState(true)
  const [xray, setXray] = useState(false)
  const [open, setOpen] = useState(false)
  const [clearFx, setClearFx] = useState(false)
  const [showTrees, setShowTrees] = useState(true)
  const wrapRef = useRef(null)
  const [narrow, setNarrow] = useState(false)
  useEffect(() => {
    const el = wrapRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver((es) => setNarrow(es[0].contentRect.width < 640))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  // On narrow twins the legend auto-collapses so it never covers the scene.
  const wasNarrow = useRef(false)
  useEffect(() => {
    if (narrow && !wasNarrow.current) setInfoOpen(false)
    wasNarrow.current = narrow
  }, [narrow])
  const [infoOpen, setInfoOpen] = useState(() => (typeof window === 'undefined' ? true : window.innerWidth > 820))
  const [osm, setOsm] = useState({ status: 'idle', buildings: [], roads: [], water: [], parks: [] })
  const [osmTick, setOsmTick] = useState(0)

  const grid = heightmap?.grid
  const path = heightmap?.flow_path || []
  /* Site-relative heights, construction-style: measured DEMs carry true
     elevations (30m plains, 880m plateau) which would launch the scene into
     the sky — so we (1) smooth DSM spikes, (2) scale relief to ≈2 world units
     so plains read flat, and (3) grade a flat pad under the proposed block,
     exactly like site cut-and-fill. Labels keep absolute meters. */
  const bcx = Number.isFinite(buildingCx) ? buildingCx : 0.475
  const bcy = Number.isFinite(buildingCy) ? buildingCy : 0.475
  const { normGrid, normMin, gradeK } = useMemo(() => {
    if (!Array.isArray(grid) || !grid.length) return { normGrid: grid, normMin: 0, gradeK: 1 }
    const n0 = grid.length
    // base normalize + coerce ragged cells
    let mn = Infinity
    const rel = grid.map((row) => (Array.isArray(row) ? row : []).map((h) => {
      const v = Number.isFinite(h) ? h : null
      if (v != null && v < mn) mn = v
      return v
    }))
    if (!Number.isFinite(mn)) return { normGrid: grid, normMin: 0, gradeK: 1 }
    // 3×3 smooth (kills rooftop/tree spikes in the satellite DEM)
    const sm = rel.map((row, r) => (row || []).map((_, c) => {
      let s = 0, n = 0
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        const rr = r + dr, cc = c + dc
        const row2 = rel[rr]
        if (row2 && row2[cc] != null) { s += row2[cc] - mn; n++ }
      }
      return n ? s / n : 0
    }))
    let mx = 0
    for (const row of sm) for (const h of row) if (h > mx) mx = h
    const k = mx > 1e-6 ? Math.max(0.5, Math.min(1.12, 2.0 / (mx * M2WORLD))) : 1
    const scaled = sm.map((row) => row.map((h) => +(h * k).toFixed(2)))
    // graded pad under the placed block (+ margin, feathered edge)
    const bcxs = bcx, bcys = bcy
    const N = scaled.length
    const padH = (() => {
      const ix = Math.max(0, Math.min(N - 1, Math.round(bcxs * (N - 1))))
      const iz = Math.max(0, Math.min(N - 1, Math.round(bcys * (N - 1))))
      return scaled[iz]?.[ix] ?? 0
    })()
    const half = 0.125 + 0.035, feather = 0.03
    const graded = scaled.map((row, r) => row.map((h, c) => {
      const nx = N > 1 ? c / (N - 1) : 0.5, ny = N > 1 ? r / (N - 1) : 0.5
      const d = Math.max(Math.abs(nx - bcxs), Math.abs(ny - bcys))
      if (d >= half + feather) return h
      if (d <= half) return padH
      const t = (d - half) / feather
      const s = t * t * (3 - 2 * t)
      return +(h * s + padH * (1 - s)).toFixed(2)
    }))
    return { normGrid: graded, normMin: mn, gradeK: k }
  }, [grid, buildingCx, buildingCy])
  const normPath = useMemo(
    () => (path || []).map((p) => ({ ...p, h: +((p.h - normMin) * gradeK).toFixed(2) })),
    [path, normMin, gradeK])
  // Proposed block must sit ON the local ground: sample the normalized height
  // under the placed footprint center (architect-movable, default 0.475).
  const buildingGroundY = useMemo(
    () => gridHeightAt(normGrid || [], bcx, bcy) * M2WORLD,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [normGrid, bcx, bcy])
  const siteKey = `${Number(siteLat).toFixed(3)},${Number(siteLng).toFixed(3)}`

  // Real area context: OSM footprints + roads around the pin (cached, offline-safe).
  useEffect(() => {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), 25000)
    let dead = false
    if (!showReal || siteLat == null || siteLng == null) {
      setOsm({ status: 'off', buildings: [], roads: [], water: [], parks: [] })
      return () => { dead = true; ctl.abort(); clearTimeout(timer) }
    }
    setOsm({ status: 'loading', buildings: [], roads: [], water: [], parks: [] })
    fetchSiteContext(siteLat, siteLng, ctl.signal)
      .then((d) => {
        if (!dead) setOsm({
          status: d.cached ? 'cached' : 'live', buildings: d.buildings || [], roads: d.roads || [],
          water: d.water || [], parks: d.parks || [], truncated: d.truncated,
        })
      })
      .catch(() => {
        if (!dead) setOsm({ status: 'unavailable', buildings: [], roads: [], water: [], parks: [] })
      })
    return () => { dead = true; ctl.abort(); clearTimeout(timer) }
  }, [siteKey, showReal, osmTick]) // eslint-disable-line

  const blockingCount = useMemo(() => {
    if (!showReal || !osm.buildings.length || !path.length) return 0
    return osm.buildings.filter((b) => footprintIntersects(b.poly, path)).length
  }, [showReal, osm.buildings, path])

  // Flood simulation timeline: 0 → dry/baseline, 1 → +2.4m storm surge
  const SIM_MAX_RISE = 2.4
  useEffect(() => {
    if (!simPlaying) return
    let raf, last = performance.now()
    const step = (now) => {
      const dt = (now - last) / 1000
      last = now
      setSimT((v) => {
        const nv = v + dt / 24 // full surge over 24 s
        if (nv >= 1) { setSimPlaying(false); return 1 }
        return nv
      })
      raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [simPlaying])

  const hasTerrain = Array.isArray(grid) && grid.length >= 4

  if (!hasTerrain) {
    return (
      <div className="rounded-2xl border border-white/10 bg-white/[.03] p-10 text-center">
        <div className="text-2xl">◌</div>
        <div className="font-bold mt-2">No terrain yet</div>
        <div className="text-xs text-slate-400 mt-1">Run “Analyze site” to generate the flow-path terrain from the risk engine. The 3D twin only renders stored analysis output — never placeholder terrain.</div>
      </div>
    )
  }

  const flowPath = path
  const outlet = heightmap?.outlet || { x: 0.85, y: 0.82 }
  const intersects = !!heightmap?.intersects
  const synthetic = !!heightmap?.synthetic
  const size = heightmap?.size || grid.length || 64
  const cellM = heightmap?.cell_m || 5
  const riseM = (Number(waterRise) || 0) + simT * SIM_MAX_RISE

  const stats = useMemo(() => {
    let mn = 1e9, mx = -1e9
    const flat = []
    for (const row of grid) {
      if (!Array.isArray(row)) continue
      for (const h of row) {
        if (!Number.isFinite(h)) continue
        mn = Math.min(mn, h); mx = Math.max(mx, h); flat.push(h)
      }
    }
    flat.sort((a, b) => a - b)
    const waterH = (flat[Math.floor(flat.length * 0.32)] ?? mn) + riseM
    const flooded = flat.filter((h) => h < waterH).length / Math.max(1, flat.length)
    return { min: mn, max: mx, floodPct: flooded * 100 }
  }, [grid, riseM])

  const riskChip = riskScore == null ? null : riskScore > 80 ? ['SEVERE', 'bg-red-500/90']
    : riskScore > 60 ? ['HIGH', 'bg-orange-500/90']
    : riskScore > 35 ? ['MODERATE', 'bg-amber-500/90'] : ['LOW', 'bg-emerald-500/90']
  const cycleQ = () => setQ((v) => (v === 'ultra' ? 'high' : v === 'high' ? 'eco' : 'ultra'))

  const hasDrains = showDrains && (drains?.length > 0 || inlets?.length > 0)
  return (
    <div ref={wrapRef} className={(open
      ? 'fixed inset-0 z-[1000] overflow-hidden bg-[#070b1d] border border-white/10 flex flex-col'
      : 'relative overflow-hidden rounded-2xl border border-white/10 shadow-[0_0_60px_-15px_rgba(34,211,238,.45)]')
      + (narrow ? ' twin-narrow' : '')}>
      <Canvas
        id="fs3d" shadows dpr={qs.dpr}
        gl={{ preserveDrawingBuffer: true, antialias: true, powerPreference: 'high-performance' }}
        camera={{ position: [15, 12, 15], fov: 42 }}
        style={{ height: open ? 'calc(100vh - 90px)' : 600, background: dusk ? '#070b1d' : '#0b1526' }}
      >
        <color attach="background" args={[dusk ? '#070b1d' : '#0a1a33']} />
        <fog attach="fog" args={[dusk ? '#070b1d' : '#0a1a33', 42, 95]} />
        <ambientLight intensity={dusk ? 0.35 : 0.65} />
        <directionalLight position={[11, 15, 7]} intensity={dusk ? 1.1 : 1.9}
          color={dusk ? '#f59e0b' : '#ffffff'} castShadow
          shadow-mapSize={[2048, 2048]}
          shadow-camera-left={-16} shadow-camera-right={16}
          shadow-camera-top={16} shadow-camera-bottom={-16} />
        <pointLight position={[-9, 6, -9]} intensity={18} color="#22d3ee" distance={30} />
        <pointLight position={[9, 4, -7]} intensity={10} color="#d946ef" distance={28} />
        <spotLight position={[0, 18, 0]} angle={0.5} intensity={dusk ? 0.4 : 0.9} color="#bae6fd" penumbra={1} />

        {dusk
          ? <Stars radius={80} depth={40} count={3500} factor={4} fade speed={0.6} />
          : <Sky sunPosition={[40, 18, -30]} turbidity={6} rayleigh={1.4} />}
        {!clearFx && <Sparkles count={qs.sparkles} scale={[22, 8, 22]} size={2.2} speed={0.35} color="#67e8f9" opacity={0.6} position={[0, 4, 0]} />}

        <Terrain grid={normGrid} riseM={riseM * gradeK} />
        <FlowTube path={normPath} />
        <FlowParticles path={normPath} count={qs.flowN} />
        {hasDrains && (
          <group opacity={xray ? 0.5 : 1}>
            <DrainNetwork drains={drains} inlets={inlets} surchargedIds={surchargedIds} grid={normGrid} />
          </group>
        )}
        {showTrees && <Trees grid={normGrid} flowPath={flowPath} drains={drains} greenSqm={greenSqm} bcx={bcx} bcy={bcy} />}
        <Building intersects={intersects} liftY={buildingGroundY + Math.max(0, (plinthM - 0.3)) * M2WORLD} footprintSqm={footprintSqm} cx={bcx} cy={bcy} />
        {showReal && osm.buildings.length > 0 && (
          <RealBuildings buildings={osm.buildings} flowPath={flowPath} grid={normGrid} siteLat={siteLat} siteLng={siteLng} />
        )}
        {showReal && osm.roads.length > 0 && <Roads roads={osm.roads} grid={normGrid} />}
        {showReal && osm.water?.length > 0 && <WaterBodies rings={osm.water} grid={normGrid} />}
        {showReal && osm.parks?.length > 0 && <ParkPatches rings={osm.parks} grid={normGrid} />}
        <SiteBoundary siteAreaM2={siteAreaM2} siteLat={siteLat} grid={normGrid} />
        {showReal && zones?.length > 0 && siteLat != null && (
          <ZoneOverlays zones={zones} siteLat={siteLat} siteLng={siteLng} grid={normGrid} flowPath={flowPath} />
        )}
        {/* Drain outlet tag replaces the generic beacon when registry drains are shown */}
        {!hasDrains && <OutletBeacon outlet={outlet} />}
        <Rain active={!clearFx && rain && (storm || simT > 0.05)} count={qs.rain} />
        <StormClouds active={!clearFx && storm} intensity={1} />
        <Lightning active={!clearFx && storm} dusk={dusk} />
        <CameraTour playing={touring} onDone={() => { setTouring(false); setSpin(true) }} />
        <FpsProbe onFps={setFps} />

        <ContactShadows position={[0, -2.75, 0]} opacity={0.65} scale={30} blur={2.4} far={6} color="#020617" />
        <gridHelper args={[24, 24, '#155e75', '#1e293b']} position={[0, -2.72, 0]} />
        <OrbitControls makeDefault enablePan enableZoom enableDamping dampingFactor={0.06}
          autoRotate={spin && !touring} autoRotateSpeed={0.55}
          maxPolarAngle={Math.PI / 2.08} minDistance={8} maxDistance={42} />
      </Canvas>

      <div className="pointer-events-none absolute inset-0" style={{ background: 'radial-gradient(120% 90% at 50% 10%, transparent 55%, rgba(2,6,23,.55) 100%)' }} />
      <div className="pointer-events-none absolute inset-x-0 top-0 h-10" style={{ background: 'linear-gradient(180deg, rgba(34,211,238,.14), transparent)' }} />

      {/* HUD legend + survey stats (collapsible so it never covers the view) */}
      <div className="twin-legend absolute z-10 top-3 left-3 rounded-xl border border-white/10 bg-slate-950/70 backdrop-blur-xl px-3 py-2 text-xs space-y-1.5 shadow-xl max-w-[248px]">
        <button onClick={() => setInfoOpen(!infoOpen)} className="flex items-center gap-2 font-extrabold tracking-widest text-teal-300 w-full text-left">
          <span className="relative flex h-2 w-2 shrink-0">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-teal-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-teal-400" />
          </span>
          <span className="truncate">3D DIGITAL TWIN · LIVE</span>
          {riskChip && <span className={`px-1.5 py-0.5 rounded text-[10px] text-white shrink-0 ${riskChip[1]}`}>{riskChip[0]}</span>}
          <span title={synthetic ? 'Analytical fallback terrain — re-run analysis with network on for measured 30m DEM' : 'Measured 30m elevation (Terrarium/SRTM) — true local topography'}
            className={`px-1.5 py-0.5 rounded text-[10px] font-extrabold shrink-0 ${synthetic ? 'bg-amber-500/90 text-white' : 'bg-sky-500/90 text-white'}`}>
            {synthetic ? 'ANALYTICAL' : 'MEASURED'}
          </span>
          <span className="ml-auto text-slate-400">{infoOpen ? '▾' : '▸'}</span>
        </button>
        {infoOpen && (
          <>
            <div className="flex items-center gap-2 text-slate-300"><span className="w-8 h-2 rounded bg-gradient-to-r from-cyan-700 via-emerald-200 to-slate-200" /> elev {stats.min.toFixed(1)}–{stats.max.toFixed(1)} m</div>
            <div className="flex items-center gap-2 text-slate-300"><span className="w-3 h-3 rounded-full bg-cyan-400 shadow-[0_0_10px_#22d3ee]" /> flow → outlet ({Number(outlet?.x).toFixed(2)}, {Number(outlet?.y).toFixed(2)})</div>
            <div className="flex items-center gap-2 text-slate-300">
              <span className={`w-3 h-3 rounded ${intersects ? 'bg-red-500 shadow-[0_0_10px_#ef4444]' : 'bg-emerald-500 shadow-[0_0_10px_#10b981]'}`} />
              {intersects ? 'proposed block intersects drainage' : 'proposed block clear'}
            </div>
            <div className="flex items-center gap-2 text-slate-300">
              <span className="w-3 h-3 rounded bg-slate-300" />
              {osm.status === 'loading' ? '⏳ reading area map…'
                : osm.status === 'live' || osm.status === 'cached'
                  ? `🏢 ${osm.buildings.length} real structures${blockingCount ? ` · ${blockingCount} on flow` : ' · none on flow'}${osm.status === 'cached' ? ' (cached)' : ''}`
                  : osm.status === 'unavailable'
                    ? <span>area map offline — surroundings hidden <button onClick={() => setOsmTick((t) => t + 1)} className="ml-1 underline text-teal-300">↻ retry</button></span>
                    : 'real structures off'}
            </div>
            {showReal && zones?.length > 0 && (
              <div className="flex items-center gap-2 text-slate-300">
                <span className="w-3 h-3 rounded bg-amber-400" /> ▦ {zones.length} tagged zone{zones.length === 1 ? '' : 's'} in 3D
              </div>
            )}
            {showDrains && (drains?.length > 0 || inlets?.length > 0) && (
              <div className="flex items-center gap-2 text-slate-300">
                <span className="w-8 h-1 rounded bg-gradient-to-r from-cyan-400 via-yellow-500 to-violet-400" />
                {drains.length} drains{inlets.length ? ` · ${inlets.length} chambers` : ''}{surchargedIds?.length ? ` · ${surchargedIds.length} surcharged` : ''}
              </div>
            )}
            {showReal && (osm.water?.length > 0 || osm.parks?.length > 0) && (
              <div className="flex items-center gap-2 text-slate-300">
                <span className="w-3 h-3 rounded bg-sky-500" />
                {osm.water?.length > 0 ? `${osm.water.length} water` : ''}{osm.water?.length > 0 && osm.parks?.length > 0 ? ' · ' : ''}{osm.parks?.length > 0 ? `${osm.parks.length} parks` : ''} · true roofs
              </div>
            )}
            {showTrees && (
              <div className="flex items-center gap-2 text-slate-300" title="Planned greenery from your green-area input — design proposal, not a tree survey">
                <span>🌳</span> planned greenery · {Math.round(Number(greenSqm) || 400)} m² input
              </div>
            )}
            <div className="flex items-center gap-2 text-slate-300" title="Site graded flat under the block, like real cut-and-fill. Surroundings keep true relief.">
              <span className="w-8 h-1 rounded bg-amber-200" /> graded pad · surroundings true
            </div>
            <div className="text-[11px] text-slate-400 font-num">
              {size}×{size} · {cellM}m cells · flooded <b className="text-cyan-300">{stats.floodPct.toFixed(0)}%</b> · +{riseM.toFixed(2)}m
            </div>
            {synthetic
              ? <div className="text-[11px] text-amber-300/90">Analytical terrain — replace with surveyed DEM for construction use</div>
              : <div className="text-[11px] text-emerald-300/90">Measured elevation grid — flow traced on real terrain</div>}
          </>
        )}
      </div>

      {/* controls */}
      <div className="twin-controls absolute z-10 top-3 right-3 flex gap-1.5 flex-wrap justify-end max-w-[52%] sm:max-w-[60%]">
        <button onClick={() => setOpen(!open)} title={open ? 'Close fullscreen twin' : 'Open twin fullscreen'}
          className="bg-cyan-500/80 hover:bg-cyan-400 backdrop-blur-md border border-cyan-300/30 text-white rounded-full font-bold shadow-[0_0_16px_rgba(34,211,238,.5)]">
          {open ? '✕ Close' : '⛶ Open'}
        </button>
        <button onClick={() => setClearFx(!clearFx)} title="Clear view: hide rain, storm, lightning and sparkles for clean inspection"
          className={`backdrop-blur-md border rounded-full font-semibold ${clearFx ? 'bg-emerald-500/80 border-emerald-300/40 text-white' : 'bg-white/10 border-white/10 text-white hover:bg-white/20'}`}>
          {clearFx ? '✨ Clear ✓' : '🧹 Clear'}
        </button>
        <button onClick={() => setShowTrees(!showTrees)} title="Toggle planned greenery (avenues + green pockets from your green-area input — not surveyed trees)"
          className={`backdrop-blur-md border rounded-full font-semibold ${showTrees ? 'bg-green-600/80 border-green-300/40 text-white' : 'bg-white/10 border-white/10 text-white hover:bg-white/20'}`}>
          {showTrees ? '🌳 Trees' : '🌳 Off'}
        </button>
        <button onClick={() => setShowReal(!showReal)} title="Toggle real OpenStreetMap structures" className={`backdrop-blur-md border rounded-full font-semibold ${showReal ? 'bg-teal-500/80 border-teal-300/40 text-white' : 'bg-white/10 border-white/10 text-white hover:bg-white/20'}`}>
          🏢 Real site
        </button>
        {(drains?.length > 0 || inlets?.length > 0) && (
          <>
            <button onClick={() => setShowDrains(!showDrains)} title="Toggle municipal drains + chambers" className={`backdrop-blur-md border rounded-full font-semibold ${showDrains ? 'bg-cyan-500/80 border-cyan-300/40 text-white' : 'bg-white/10 border-white/10 text-white hover:bg-white/20'}`}>
              {showDrains ? '🌊 Drains' : '🌊 Off'}
            </button>
            <button onClick={() => setXray(!xray)} title="X-ray: see buried sewer pipes" className={`backdrop-blur-md border rounded-full font-semibold ${xray ? 'bg-violet-500/80 border-violet-300/40 text-white' : 'bg-white/10 border-white/10 text-white hover:bg-white/20'}`}>
              {xray ? '🔍 X-ray on' : '🔍 X-ray'}
            </button>
          </>
        )}
        <button onClick={() => setSpin(!spin)} title="Toggle auto-orbit" className="bg-white/10 hover:bg-white/20 backdrop-blur-md border border-white/10 text-white rounded-full font-semibold">
          {spin ? '⏸ Orbit' : '▶ Orbit'}
        </button>
        <button onClick={() => setRain(!rain)} title="Toggle rain FX" className="bg-white/10 hover:bg-white/20 backdrop-blur-md border border-white/10 text-white rounded-full font-semibold">
          {rain ? '🌧 Rain' : '🌧 Off'}
        </button>
        <button onClick={() => setStorm(!storm)} title="Toggle storm clouds + lightning" className={`backdrop-blur-md border rounded-full font-semibold ${storm ? 'bg-indigo-500/70 border-indigo-300/30 text-white' : 'bg-white/10 border-white/10 text-white hover:bg-white/20'}`}>
          ⛈ Storm
        </button>
        <button onClick={() => { setTouring(true); setSpin(false) }} title="Play cinematic guided tour" className="bg-fuchsia-500/80 hover:bg-fuchsia-400 border border-fuchsia-300/30 text-white rounded-full font-semibold">
          🎬 Tour
        </button>
        <button onClick={cycleQ} title="Cycle render quality" className="bg-white/10 hover:bg-white/20 backdrop-blur-md border border-white/10 text-white rounded-full font-semibold uppercase">
          {q} · {fps}
        </button>
        <button
          onClick={() => { const c = document.querySelector('#fs3d canvas'); if (c) setSnap(c.toDataURL('image/png')) }}
          className="bg-teal-500/90 hover:bg-teal-400 text-white rounded-full font-bold shadow-[0_0_20px_rgba(20,184,166,.6)]">
          📸 Shot
        </button>
      </div>

      {/* flood simulation timeline */}
      <div className="absolute z-10 bottom-14 left-1/2 -translate-x-1/2 w-[min(560px,86%)] bg-slate-950/70 backdrop-blur-xl border border-white/10 rounded-2xl px-4 py-2.5 shadow-xl">
        <div className="flex items-center gap-3">
          <button
            onClick={() => { if (simT >= 1) setSimT(0); setSimPlaying(!simPlaying) }}
            className="w-8 h-8 shrink-0 grid place-items-center rounded-full bg-cyan-500/90 hover:bg-cyan-400 text-white text-sm font-bold shadow-[0_0_16px_rgba(34,211,238,.5)]">
            {simPlaying ? '⏸' : '▶'}
          </button>
          <input type="range" min="0" max="1" step="0.001" value={simT}
            onChange={(e) => { setSimT(Number(e.target.value)); setSimPlaying(false) }}
            className="flex-1 accent-cyan-400 h-1.5 cursor-pointer" />
          <div className="text-[11px] font-num text-cyan-200 w-24 text-right">
            +{(simT * SIM_MAX_RISE).toFixed(2)} m
          </div>
        </div>
        <div className="flex justify-between text-[10px] text-slate-400 mt-0.5 px-11">
          <span>baseline</span><span>storm surge +{(SIM_MAX_RISE).toFixed(1)} m</span>
        </div>
      </div>

      {/* north arrow + scale bar (hidden on narrow twins where it collides with the timeline) */}
      {!narrow && (
        <div className="absolute z-10 bottom-12 right-3 flex flex-col items-end gap-2">
          <div className="w-9 h-9 rounded-full bg-slate-950/70 border border-white/15 backdrop-blur-md grid place-items-center text-sm font-black text-slate-200" title="North">N<span className="text-teal-300 -mt-1">↑</span></div>
          <div className="bg-slate-950/60 border border-white/10 rounded-full px-2.5 py-1 text-[10px] font-num text-slate-300">▔▔▔ {(size * cellM)} m site width</div>
        </div>
      )}

      <div className="absolute z-10 bottom-3 left-3 text-[11px] text-slate-300/90 bg-slate-950/60 backdrop-blur-md border border-white/10 px-3 py-1.5 rounded-full">
        drag · orbit &nbsp;&nbsp; scroll · zoom &nbsp;&nbsp; right-drag · pan
      </div>
      <div className="absolute z-10 bottom-3 right-3 flex gap-2 items-center">
        {snap && <a href={snap} download="3d-scene.png" className="text-xs underline text-teal-300 bg-slate-950/60 px-3 py-1.5 rounded-full border border-white/10">download ↓</a>}
        <span className="text-[10px] font-bold tracking-widest text-slate-400 bg-slate-950/60 px-2.5 py-1.5 rounded-full border border-white/10 uppercase">{q} · WebGL2</span>
      </div>
    </div>
  )
}
