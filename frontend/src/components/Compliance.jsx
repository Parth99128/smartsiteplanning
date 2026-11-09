import { buildCompliance } from '../lib/compliance'

const PILL = {
  pass: 'bg-emerald-500/15 border-emerald-400/30 text-emerald-300',
  fail: 'bg-red-500/15 border-red-400/30 text-red-300',
  info: 'bg-white/5 border-white/10 text-slate-400',
}
const DOT = { pass: '✓', fail: '✕', info: '○' }

/* No-waterlogging compliance sheet. Props: { factors, design, siteArea,
   roofSqm, intersects, hyd, basement, city }. Pure render of buildCompliance. */
export default function Compliance(props) {
  const sheet = buildCompliance(props)
  return (
    <div>
      <div className="flex items-center gap-2 flex-wrap">
        <span className={`text-[11px] font-extrabold px-2.5 py-1 rounded-full border ${sheet.failed === 0 ? PILL.pass : PILL.fail}`}>
          {sheet.verdict}
        </span>
        <span className="text-[11px] text-slate-400">
          {sheet.passed} pass · {sheet.failed} fix · {sheet.open} open
        </span>
      </div>
      <div className="mt-2 space-y-1.5">
        {sheet.checks.map((c) => (
          <div key={c.id} className="flex gap-2.5 items-start bg-white/[.03] border border-white/10 rounded-xl px-3 py-2">
            <span className={`w-5 h-5 shrink-0 grid place-items-center rounded-full border text-[11px] font-black ${PILL[c.status]}`}>
              {DOT[c.status]}
            </span>
            <div className="min-w-0">
              <div className="text-[12px] font-bold text-slate-100">
                {c.label} <span className="font-normal text-slate-400">· {c.measured} vs {c.required}</span>
              </div>
              <div className="text-[11px] text-slate-400 leading-snug">{c.note}</div>
              <div className="text-[10px] text-slate-500">Basis: {c.basis}</div>
            </div>
          </div>
        ))}
      </div>
      <div className="text-[10px] text-slate-500 mt-2">{sheet.disclaimer}</div>
    </div>
  )
}
