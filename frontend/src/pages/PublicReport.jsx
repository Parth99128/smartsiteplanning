import { useEffect, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { apiGet } from '../lib/api'
import { Skeleton } from '../components/ui'

// Public read-only report — no login, no editing. Opened via /r/:token share links.
export default function PublicReport() {
  const { token } = useParams()
  const [data, setData] = useState(null)
  const [err, setErr] = useState('')

  useEffect(() => {
    apiGet(`/public/${token}`)
      .then((r) => setData(r.data))
      .catch(() => setErr('Report not found or backend offline.'))
  }, [token])

  return (
    <div className="min-h-screen grid place-items-center p-6">
      <div className="glass p-8 max-w-lg w-full text-center">
        <div className="w-10 h-10 mx-auto rounded-xl bg-gradient-to-br from-cyan-400 to-teal-600 grid place-items-center font-black">◈</div>
        <h1 className="font-extrabold text-lg mt-2">FloodShield AI — Shared Report</h1>
        <div className="text-[11px] text-slate-400">read-only · token <code className="text-teal-300">{token}</code> · planning-grade estimate</div>
        {err && <div className="text-sm text-red-300 mt-4">{err}</div>}
        {!data && !err && <div className="mt-4 space-y-2"><Skeleton className="h-6" /><Skeleton className="h-16" /></div>}
        {data?.error && <div className="text-sm text-red-300 mt-4">Unknown share token.</div>}
        {data?.project && (
          <div className="text-left text-sm mt-4 space-y-1.5">
            <div className="font-bold text-base">{data.project.name}</div>
            <div className="grid grid-cols-2 gap-2 text-xs">
              <div className="bg-white/5 rounded-xl p-2.5">Footprint<br /><b className="font-num">{data.project.footprint_sqm} m²</b></div>
              <div className="bg-white/5 rounded-xl p-2.5">Built-up<br /><b className="font-num">{data.project.builtup_pct}%</b></div>
            </div>
            {data.read_only && <div className="text-[11px] text-emerald-300">✓ verified read-only share</div>}
            <div className="text-slate-500 text-xs mt-2">Full analysis, 3D digital twin, what-if simulator and PDF export live inside the app.</div>
          </div>
        )}
        <Link to="/" className="inline-block mt-5 text-xs bg-teal-400 text-[#0b1526] px-4 py-2 rounded-full font-bold">Open FloodShield AI →</Link>
      </div>
    </div>
  )
}
