import { motion } from 'framer-motion'
import { levelColor, nextBadge } from '../lib/risk'

/* Legacy-compatible + industry-grade display bits. */

export function ScoreCard({ label, value, suffix = '', color = 'text-teal-300', sub }) {
  return (
    <div>
      <div className="eyebrow">{label}</div>
      <motion.div key={String(value)} initial={{ scale: 0.85, opacity: 0.4 }} animate={{ scale: 1, opacity: 1 }}
        className={`font-num text-4xl font-bold mt-1 ${color}`}>
        {value}{suffix}
      </motion.div>
      {sub && <div className="text-xs text-slate-400 mt-1">{sub}</div>}
    </div>
  )
}

export function RiskCard({ value, climate }) {
  const sub = `climate +${climate ?? 0}% · ${value == null ? 'run analysis' : 'live model output'}`
  return <ScoreCard label="Flood risk (0-100)" value={value ?? '—'} color={value == null ? 'text-slate-400' : levelColor(value)} sub={sub} />
}

export function Badge({ level }) {
  const map = {
    Bronze: 'from-amber-700 via-amber-500 to-amber-300 text-[#2a1503]',
    Silver: 'from-slate-300 via-slate-100 to-slate-300 text-[#1e293b]',
    Gold: 'from-yellow-600 via-yellow-400 to-amber-200 text-[#422006]',
    Platinum: 'from-cyan-300 via-teal-200 to-violet-300 text-[#06202e]',
  }
  return (
    <div className={`inline-flex items-center gap-1.5 px-4 py-2 rounded-full font-extrabold text-[13px] bg-gradient-to-r ${map[level] || map.Bronze} shadow-glow`}>
      ◆ {level || 'Bronze'} <span className="font-semibold opacity-80">RESILIENCE</span>
    </div>
  )
}

export function BadgePro({ level, score }) {
  const { next, gap } = nextBadge(score)
  return (
    <div className="flex flex-col gap-2">
      <Badge level={level} />
      {score != null && (
        <div>
          <div className="flex justify-between text-[11px] text-slate-400">
            <span className="font-num text-teal-300 font-bold">{score}</span>
            <span>{next ? `${gap} pts → ${next}` : 'max tier ✓'}</span>
          </div>
          <div className="h-1.5 bg-white/10 rounded-full overflow-hidden mt-1">
            <div className="h-full bg-gradient-to-r from-teal-400 to-cyan-300 transition-all" style={{ width: `${Math.min(100, Number(score))}%` }} />
          </div>
        </div>
      )}
    </div>
  )
}

/* SVG semicircular gauge 0–100 with level coloring. */
export function RiskGauge({ value, size = 170 }) {
  const v = Math.max(0, Math.min(100, Number(value ?? 0)))
  const r = 70, cx = 90, cy = 90
  const polar = (deg) => {
    const a = (deg * Math.PI) / 180
    return [cx + r * Math.cos(a), cy - r * Math.sin(a)]
  }
  const arc = (a0, a1) => {
    const [x0, y0] = polar(a0); const [x1, y1] = polar(a1)
    return `M ${x0} ${y0} A ${r} ${r} 0 0 1 ${x1} ${y1}`
  }
  const needle = polar(180 - (v / 100) * 180)
  const col = v > 80 ? '#f87171' : v > 60 ? '#fb923c' : v > 35 ? '#facc15' : '#34d399'
  return (
    <svg width={size} height={size * 0.62} viewBox="20 5 140 85">
      <path d={arc(180, 0)} fill="none" stroke="#1e293b" strokeWidth="12" strokeLinecap="round" />
      <path d={arc(180, 180 - (v / 100) * 180)} fill="none" stroke={col} strokeWidth="12" strokeLinecap="round"
        style={{ filter: `drop-shadow(0 0 6px ${col})` }} />
      <line x1={cx} y1={cy} x2={needle[0]} y2={needle[1]} stroke="#e2e8f0" strokeWidth="2.5" strokeLinecap="round" />
      <circle cx={cx} cy={cy} r="5" fill="#e2e8f0" />
      <text x={cx} y={cy - 18} textAnchor="middle" fill={col} fontSize="20" fontWeight="800" fontFamily="JetBrains Mono, monospace">
        {value == null ? '—' : Number(value).toFixed(0)}
      </text>
    </svg>
  )
}

export function Delta({ before, after, invert = false }) {
  if (before == null || after == null) return null
  const d = +(Number(after) - Number(before)).toFixed(1)
  const good = invert ? d < 0 : d > 0
  if (!d) return <span className="text-[11px] text-slate-500">±0</span>
  return (
    <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full ${good ? 'bg-emerald-500/15 text-emerald-300' : 'bg-red-500/15 text-red-300'}`}>
      {d > 0 ? '▲ +' : '▼ '}{d}
    </span>
  )
}
