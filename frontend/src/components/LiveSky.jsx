import { useEffect, useState } from 'react'
import { fetchWeather, codeLabel } from '../lib/weather'
import { useStore } from '../store'

/* Live atmosphere over the pin: nowcast + 24h forecast vs the site's design
   rainfall. One click re-scores the ACTIVE design against the live storm. */
export default function LiveSky({ lat, lng, designRain }) {
  const simulate = useStore((s) => s.simulate)
  const notify = useStore((s) => s.notify)
  const [wx, setWx] = useState(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let dead = false
    const ctl = new AbortController()
    const t = setTimeout(async () => {
      try {
        const w = await fetchWeather(lat, lng, ctl.signal)
        if (!dead) setWx(w)
      } catch { if (!dead) setWx(null) }
    }, 350)
    return () => { dead = true; clearTimeout(t); ctl.abort() }
  }, [Number(lat)?.toFixed?.(2), Number(lng)?.toFixed?.(2)]) // eslint-disable-line

  const test = async () => {
    if (!wx || busy) return
    setBusy(true)
    try {
      await simulate({ rainfall_mm: wx.testRainMm })
      notify(`Design re-scored against live sky: ${wx.testRainMm} mm storm`, 'success')
    } catch { /* simulate surfaces its own error */ }
    setBusy(false)
  }

  const exceeds = wx && Number.isFinite(designRain) && wx.next24hMm > designRain

  return (
    <div className="flex flex-wrap items-center gap-3">
      <div className="text-2xl">{wx ? (wx.rainingNowMmHr > 0 ? '🌧️' : '🌤️') : '🛰️'}</div>
      <div className="flex-1 min-w-[220px]">
        <div className="font-bold text-sm text-slate-100">
          Live sky {wx ? `· ${codeLabel(wx.code)}${wx.cached ? ' (cached)' : ''}` : '· offline — slider only'}
        </div>
        {wx ? (
          <div className="text-[11px] text-slate-400 font-num">
            now {wx.rainingNowMmHr} mm/hr · next 24 h {wx.next24hMm} mm · peak {wx.peakHourMmHr} mm/hr
            {Number.isFinite(designRain) && (
              exceeds
                ? <span className="text-red-300 font-bold"> · EXCEEDS your {designRain} mm design ⚠</span>
                : <span className="text-emerald-300"> · within your {designRain} mm design ✓</span>
            )}
          </div>
        ) : (
          <div className="text-[11px] text-slate-500">Live feed unreachable — design sliders still work.</div>
        )}
      </div>
      {wx && (
        <button onClick={test} disabled={busy}
          className="bg-sky-400 text-[#0b1526] px-4 py-2 rounded-xl font-bold text-sm disabled:opacity-50 hover:brightness-110">
          {busy ? 'Scoring…' : `⛈ Test this ${wx.testRainMm} mm storm →`}
        </button>
      )}
    </div>
  )
}
