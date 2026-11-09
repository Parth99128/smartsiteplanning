import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { Btn, ConnectionBanner, HealthPill, Toasts } from '../components/ui'
import CreateProjectWizard from '../components/CreateProjectWizard'

const link = ({ isActive }) =>
  `group flex items-center gap-3 px-4 py-2.5 rounded-xl text-sm font-bold transition border ${isActive
    ? 'bg-gradient-to-r from-cyan-400 to-teal-400 text-[#0b1526] border-transparent shadow-[0_0_28px_-8px_rgba(34,211,238,.8)]'
    : 'bg-white/[.04] text-slate-200 border-white/10 hover:bg-white/10 hover:border-white/20'}`

const NAV = [
  { to: '/', label: 'Dashboard', icon: '◈', end: true },
  { to: '/compare', label: 'Compare', icon: '▦' },
  { to: '/siteplan', label: 'Site Plan', icon: '🗺' },
  { to: '/report', label: 'Report', icon: '☷' },
]

function nextDelay(fails) {
  if (fails <= 0) return 30000
  return Math.min(300000, 15000 * 2 ** Math.min(fails, 4)) // 30s → 1m → 2m → 4m → 5m
}

export default function AppShell() {
  const { projects, activeId, toast, health, healthFails, online, loading, selectProject, dismissToast } = useStore()
  const loadProjects = useStore((s) => s.loadProjects)
  const refreshHealth = useStore((s) => s.refreshHealth)
  const [q, setQ] = useState('')
  const [showNew, setShowNew] = useState(false)
  const [retryIn, setRetryIn] = useState(null)
  const timer = useRef(null)
  const tick = useRef(null)
  const location = useLocation()

  // Online / offline awareness (no pointless polling while offline).
  useEffect(() => {
    const on = () => useStore.setState({ online: true })
    const off = () => useStore.setState({ online: false })
    window.addEventListener('online', on)
    window.addEventListener('offline', off)
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off) }
  }, [])

  // Adaptive health + project polling with backoff while the backend is down.
  useEffect(() => {
    let alive = true
    const poll = async () => {
      if (!alive) return
      if (!useStore.getState().online) {
        timer.current = setTimeout(poll, 15000)
        return
      }
      try {
        await refreshHealth()
        const fails = useStore.getState().healthFails
        if (useStore.getState().health.backend === 'up') {
          await loadProjects().catch(() => {})
        }
        if (!alive) return
        const d = nextDelay(fails)
        setRetryIn(fails > 0 ? Math.round(d / 1000) : null)
        timer.current = setTimeout(poll, d)
      } catch {
        if (!alive) return
        const fails = useStore.getState().healthFails
        const d = nextDelay(fails)
        setRetryIn(Math.round(d / 1000))
        timer.current = setTimeout(poll, d)
      }
    }
    loadProjects().catch(() => {})
    poll()
    return () => { alive = false; clearTimeout(timer.current) }
    // eslint-disable-next-line
  }, [])

  // Retry countdown ticker for the banner.
  useEffect(() => {
    clearInterval(tick.current)
    if (retryIn == null) return
    tick.current = setInterval(() => setRetryIn((v) => (v == null || v <= 1 ? v : v - 1)), 1000)
    return () => clearInterval(tick.current)
  }, [retryIn !== null]) // eslint-disable-line

  const retryNow = () => {
    setRetryIn(null)
    refreshHealth().then(() => loadProjects().catch(() => {})).catch(() => {})
  }

  const list = projects.filter((p) => (p.name || '').toLowerCase().includes(q.toLowerCase()))
  const backendDown = online && healthFails >= 2 && health.backend !== 'up'

  const side = (
    <>
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-2xl bg-gradient-to-br from-cyan-300 via-cyan-500 to-teal-600 grid place-items-center font-black text-lg text-[#06202e] shrink-0 shadow-[0_0_28px_-6px_rgba(34,211,238,.8)]">◈</div>
        <div>
          <div className="font-extrabold tracking-tight text-[15px]">FloodShield AI</div>
          <div className="text-[11px] text-slate-400">Pre-construction flood resilience</div>
        </div>
      </div>

      <nav className="flex md:flex-col gap-2 mt-5">
        {NAV.map((n) => (
          <NavLink key={n.to} to={n.to} end={n.end} className={link}>
            <span className="text-base leading-none">{n.icon}</span> {n.label}
          </NavLink>
        ))}
      </nav>

      <div className="mt-5">
        <div className="eyebrow mb-2">Active project</div>
        {projects.length ? (
          <>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search projects…"
              className="field !text-xs mb-2" />
            <select value={activeId ?? ''} onChange={(e) => selectProject(e.target.value)} className="field">
              {list.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            {!list.length && <div className="text-[11px] text-slate-500 mt-1">No projects match “{q}”.</div>}
          </>
        ) : (
          <div className="text-[12px] text-slate-400 bg-white/5 border border-dashed border-white/15 rounded-xl p-3">
            No projects yet — pick a site on the map to begin.
          </div>
        )}
        <Btn variant={showNew ? 'ghost' : 'primary'} onClick={() => setShowNew(!showNew)} className="mt-2.5 w-full">
          {showNew ? 'Close' : '+ New site · pick on map'}
        </Btn>
        {showNew && (
          <div className="mt-2 animate-fade-up">
            <CreateProjectWizard compact onCreated={() => setShowNew(false)} />
          </div>
        )}
      </div>

      <div className="mt-5 flex flex-wrap gap-1.5">
        <HealthPill label="ML" status={health.ml} />
        <HealthPill label="API" status={!online ? 'reconnecting' : backendDown ? 'reconnecting' : health.backend} />
      </div>
      <div className="mt-auto pt-5 text-[10px] leading-relaxed text-slate-500 hidden md:block">
        Planning-grade estimates — verify with a licensed engineer.<br />FloodShield AI · v1.0
      </div>
    </>
  )

  return (
    <div className="min-h-screen md:flex">
      <aside className="hidden md:flex flex-col w-[280px] shrink-0 sticky top-0 h-screen backdrop-blur-xl bg-[#0a1428]/80 border-r border-white/10 p-5">
        {side}
      </aside>
      <div className="flex-1 min-w-0">
        <div className="md:hidden sticky top-0 z-20 backdrop-blur-xl bg-[#0a1428]/90 border-b border-white/10 px-4 py-3">
          <div className="flex items-center gap-2.5 mb-3">
            <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-cyan-300 to-teal-600 grid place-items-center font-black text-[#06202e]">◈</div>
            <div className="font-extrabold tracking-tight text-sm">FloodShield AI</div>
            <div className="ml-auto flex gap-1.5">
              <HealthPill label="ML" status={health.ml} />
              <HealthPill label="API" status={!online ? 'reconnecting' : backendDown ? 'reconnecting' : health.backend} />
            </div>
          </div>
          <nav className="flex gap-2">
            {NAV.map((n) => (
              <NavLink key={n.to} to={n.to} end={n.end} className={link}><span>{n.icon}</span> {n.label}</NavLink>
            ))}
          </nav>
        </div>

        {loading && <div className="h-0.5 bg-gradient-to-r from-cyan-400 via-teal-300 to-cyan-400 animate-pulse" />}

        <ConnectionBanner online={online} backendDown={backendDown} reconnectIn={retryIn} onRetry={retryNow} />

        <main key={location.pathname} className="view-enter">
          <Outlet />
        </main>

        <footer className="px-6 pb-8 pt-2 text-[11px] text-slate-500 max-w-[1400px] mx-auto">
          FloodShield AI · Random-Forest + flow-path terrain twin ·{' '}
          <span className="text-slate-400">Planning-grade estimates, not flood-safety certification.</span>
        </footer>
      </div>
      <Toasts toast={toast} onDismiss={dismissToast} />
    </div>
  )
}
