import React, { useEffect } from 'react'

/* Design-system primitives: buttons, cards, headers, skeletons, health, toasts, banners. */

const btnBase = 'inline-flex items-center justify-center gap-2 px-4 py-2 rounded-xl text-sm font-bold transition active:scale-[.98] disabled:opacity-40 disabled:pointer-events-none select-none'

export function Btn({ variant = 'ghost', size, loading, className = '', children, ...props }) {
  const map = {
    primary: 'bg-gradient-to-r from-cyan-400 to-teal-400 text-[#0b1526] hover:brightness-110 shadow-[0_0_30px_-8px_rgba(34,211,238,.7)]',
    ghost: 'bg-white/10 text-slate-200 hover:bg-white/20 border border-white/10',
    danger: 'bg-red-500/90 text-white hover:bg-red-400',
    violet: 'bg-gradient-to-r from-violet-400 to-fuchsia-400 text-[#0b1526] hover:brightness-110',
  }
  const sz = size === 'sm' ? 'px-3 py-1.5 text-xs rounded-full' : size === 'lg' ? 'px-6 py-3 text-base rounded-2xl' : ''
  return (
    <button className={`${btnBase} ${map[variant] || map.ghost} ${sz} ${className}`} disabled={loading || props.disabled} {...props}>
      {loading && <span className="w-3.5 h-3.5 rounded-full border-2 border-current border-t-transparent animate-spin" />}
      {children}
    </button>
  )
}

export function Card({ title, sub, actions, className = '', children, ...props }) {
  return (
    <div className={`glass p-5 ${className}`} {...props}>
      {(title || actions) && (
        <div className="flex items-start justify-between gap-3 mb-3 flex-wrap">
          <div>
            {title && <div className="font-bold text-[15px] tracking-tight">{title}</div>}
            {sub && <div className="text-xs text-slate-400 mt-0.5">{sub}</div>}
          </div>
          {actions && <div className="flex gap-2 flex-wrap">{actions}</div>}
        </div>
      )}
      {children}
    </div>
  )
}

export function PageHeader({ eyebrow, title, sub, actions }) {
  return (
    <div className="flex items-start justify-between gap-3 flex-wrap">
      <div>
        {eyebrow && <div className="eyebrow mb-1">{eyebrow}</div>}
        <h1 className="h-display text-xl">{title}</h1>
        {sub && <p className="text-[13px] text-slate-400 mt-1 max-w-2xl">{sub}</p>}
      </div>
      {actions && <div className="flex gap-2 flex-wrap items-center">{actions}</div>}
    </div>
  )
}

export function SectionHead({ title, sub, right }) {
  return (
    <div className="flex items-center justify-between gap-2 mb-3 flex-wrap">
      <div>
        <div className="font-bold text-[15px] tracking-tight">{title}</div>
        {sub && <div className="text-xs text-slate-400 font-normal">{sub}</div>}
      </div>
      {right}
    </div>
  )
}

export function Skeleton({ className = 'h-24' }) {
  return <div className={`skeleton ${className}`} />
}

export function Empty({ icon = '◌', title = 'No data yet', hint = '', action }) {
  return (
    <div className="rounded-2xl border border-dashed border-white/15 bg-white/[.03] p-8 text-center">
      <div className="text-2xl text-slate-500">{icon}</div>
      <div className="font-bold mt-2">{title}</div>
      {hint && <div className="text-[13px] text-slate-400 mt-1 max-w-md mx-auto">{hint}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}

const pillDot = {
  up: 'bg-emerald-400 shadow-[0_0_8px_#34d399]',
  down: 'bg-red-400 shadow-[0_0_8px_#ef4444] animate-pulse-dot',
  degraded: 'bg-amber-400 shadow-[0_0_8px_#f59e0b]',
  reconnecting: 'bg-amber-400 shadow-[0_0_8px_#f59e0b] animate-pulse-dot',
  unknown: 'bg-slate-500',
}
const pillTxt = {
  up: 'text-emerald-300', down: 'text-red-300', degraded: 'text-amber-300',
  reconnecting: 'text-amber-300', unknown: 'text-slate-400',
}

export function HealthPill({ label, status }) {
  const s = status || 'unknown'
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] font-bold bg-white/5 border border-white/10 px-2.5 py-1 rounded-full">
      <span className={`w-2 h-2 rounded-full ${pillDot[s] || pillDot.unknown}`} />
      <span className={pillTxt[s] || pillTxt.unknown}>{label} {s === 'unknown' ? '…' : s}</span>
    </span>
  )
}

const toastTone = {
  info: 'bg-cyan-400/10 border-cyan-300/30 text-cyan-100',
  success: 'bg-emerald-400/10 border-emerald-300/30 text-emerald-100',
  error: 'bg-red-400/10 border-red-300/40 text-red-100',
  warn: 'bg-amber-400/15 border-amber-300/40 text-amber-100',
}

export function Toasts({ toast, onDismiss }) {
  const t = !toast ? null : typeof toast === 'string' ? { msg: toast, kind: 'info' } : toast
  useEffect(() => {
    if (!t) return
    const id = setTimeout(() => onDismiss?.(), t.kind === 'error' ? 8000 : 5000)
    return () => clearTimeout(id)
  }, [t?.msg, t?.kind]) // eslint-disable-line
  if (!t) return null
  return (
    <div className={`fixed bottom-5 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 max-w-[92vw] text-[13px] border pl-4 pr-2 py-2.5 rounded-2xl backdrop-blur-xl shadow-2xl ${toastTone[t.kind] || toastTone.info}`}>
      <span className="truncate">{t.msg}</span>
      <button onClick={onDismiss} className="shrink-0 bg-white/10 hover:bg-white/20 px-2.5 py-1 rounded-lg font-bold">✕</button>
    </div>
  )
}

export function ErrorBanner({ message, onRetry, onDismiss, tone = 'error' }) {
  if (!message) return null
  const map = {
    error: 'bg-red-500/10 border-red-400/40 text-red-200',
    warn: 'bg-amber-500/10 border-amber-400/40 text-amber-100',
  }
  return (
    <div className={`flex items-center gap-3 text-[13px] border px-4 py-3 rounded-2xl ${map[tone]}`}>
      <span className="font-bold">{tone === 'warn' ? '◷' : '⚠'}</span>
      <span className="flex-1">{message}</span>
      {onRetry && <button onClick={onRetry} className="bg-white/10 hover:bg-white/20 px-3 py-1.5 rounded-lg font-bold text-xs">Retry</button>}
      {onDismiss && <button onClick={onDismiss} className="px-2 opacity-70 hover:opacity-100">✕</button>}
    </div>
  )
}

/* Persistent connectivity banner: offline vs backend-down vs reconnecting. */
export function ConnectionBanner({ online, backendDown, reconnectIn, onRetry }) {
  if (online && !backendDown) return null
  return (
    <div className="sticky top-0 z-30 px-4 sm:px-6 pt-3">
      <div className="max-w-6xl mx-auto flex items-center gap-3 text-[13px] bg-amber-500/10 border border-amber-400/40 text-amber-100 px-4 py-2.5 rounded-2xl backdrop-blur-xl">
        <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse-dot shrink-0" />
        <span className="flex-1">
          {!online
            ? "You're offline — changes will resume when the connection returns."
            : `Backend unreachable${reconnectIn ? ` — retrying in ${reconnectIn}s` : ' — retrying'}… Your data is safe.`}
        </span>
        <button onClick={onRetry} className="bg-amber-400/20 hover:bg-amber-400/30 px-3 py-1.5 rounded-lg font-bold text-xs shrink-0">Retry now</button>
      </div>
    </div>
  )
}

export function Stat({ label, value, sub, tone = 'text-slate-100' }) {
  return (
    <div>
      <div className="eyebrow">{label}</div>
      <div className={`font-num text-3xl font-bold mt-1 ${tone}`}>{value}</div>
      {sub && <div className="text-xs text-slate-400 mt-1">{sub}</div>}
    </div>
  )
}

export class ErrorBoundary extends React.Component {
  constructor(p) { super(p); this.state = { err: null, showDetail: false } }
  static getDerivedStateFromError(err) { return { err } }
  componentDidCatch(err, info) {
    console.error('[FloodShield UI error]', err, info?.componentStack)
    try {
      sessionStorage.setItem('fs-last-ui-error', JSON.stringify({
        ts: Date.now(), view: window.location.hash || window.location.pathname,
        message: String(err?.message || err), stack: String(err?.stack || '').slice(0, 2000),
      }))
    } catch { /* private mode */ }
  }
  render() {
    const { err, showDetail } = this.state
    if (err) {
      const detail = `${String(err?.message || err)}\n${String(err?.stack || '').slice(0, 1200)}`
      return (
        <div className="p-8 max-w-xl mx-auto">
          <div className="glass p-6 text-center">
            <div className="text-3xl">⚠</div>
            <div className="font-extrabold mt-2">Something broke in this view</div>
            <div className="text-[13px] text-slate-400 mt-1">The 3D engine or charts hit an unexpected value. Your analysis data is safe.</div>
            <div className="text-[12px] font-mono text-red-300 bg-red-500/10 border border-red-400/30 rounded-xl px-3 py-2 mt-3 text-left break-words">
              {String(err?.message || err)}
            </div>
            <div className="flex gap-2 justify-center mt-4 flex-wrap">
              <button onClick={() => this.setState({ err: null })} className="btn-primary btn-sm">Try again</button>
              <button onClick={() => window.location.reload()} className="btn-ghost btn-sm">Reload app</button>
              <button
                onClick={() => {
                  try { navigator.clipboard.writeText(detail) } catch { /* clipboard denied */ }
                  this.setState({ showDetail: !showDetail })
                }}
                className="btn-ghost btn-sm">{showDetail ? 'Hide details' : 'Copy details'}</button>
            </div>
            {showDetail && (
              <pre className="text-[10px] text-left text-slate-400 bg-black/30 rounded-xl p-3 mt-3 overflow-auto max-h-48 whitespace-pre-wrap">{detail}</pre>
            )}
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
