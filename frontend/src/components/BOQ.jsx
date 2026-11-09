import { useState } from 'react'
import { DEFAULT_RATES, buildBOQ, boqCSV, loadRates, saveRates } from '../lib/boq'
import { download } from '../lib/risk'

const fmt = (n) => n >= 100000 ? `₹${(n / 100000).toFixed(2)}L` : `₹${Math.round(n / 1000)}k`

/* BOQ table from the simulated design. Props: { design, basement }.
   Rates are editable + persisted; CSV downloads for the estimator. */
export default function BOQ({ design = {}, basement = {} }) {
  const [rates, setRates] = useState(loadRates)
  const [edit, setEdit] = useState(false)
  const boq = buildBOQ(design, basement, rates)

  const setRate = (k, v) => {
    const next = { ...rates, [k]: Math.max(0, Number(v) || 0) }
    setRates(next)
    saveRates(next)
  }
  const reset = () => { setRates({ ...DEFAULT_RATES }); saveRates({ ...DEFAULT_RATES }) }

  return (
    <div>
      <div className="flex items-center gap-2 flex-wrap">
        <span className="font-num text-2xl font-bold text-teal-300">{fmt(boq.total)}</span>
        <span className="text-[11px] text-slate-400">{boq.lines.length} line items</span>
        <span className="ml-auto flex gap-1.5">
          <button onClick={() => setEdit(!edit)} className="text-[11px] px-2.5 py-1 rounded-full bg-white/10 hover:bg-white/20">
            {edit ? 'Done' : '✎ Edit rates'}
          </button>
          <button onClick={reset} className="text-[11px] px-2.5 py-1 rounded-full bg-white/10 hover:bg-white/20">Reset</button>
          <button onClick={() => download('floodshield-boq.csv', boqCSV(boq), 'text/csv')}
            className="text-[11px] px-2.5 py-1 rounded-full bg-teal-400 text-[#0b1526] font-bold">⬇ CSV</button>
        </span>
      </div>
      {edit && (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5 mt-2">
          {Object.entries(rates).map(([k, v]) => (
            <label key={k} className="text-[10px] text-slate-400">
              {k.replace(/_/g, ' ')} (₹)
              <input type="number" value={v} min={0} onChange={(e) => setRate(k, e.target.value)}
                className="field !py-1 mt-0.5" />
            </label>
          ))}
        </div>
      )}
      <div className="mt-2 overflow-auto">
        <table className="w-full text-[11px]">
          <thead>
            <tr className="text-slate-500 text-left border-b border-white/10">
              <th className="py-1 pr-2 font-semibold">Item</th>
              <th className="py-1 pr-2 font-semibold text-right">Qty</th>
              <th className="py-1 pr-2 font-semibold">Unit</th>
              <th className="py-1 pr-2 font-semibold text-right">Rate ₹</th>
              <th className="py-1 font-semibold text-right">Amount</th>
            </tr>
          </thead>
          <tbody>
            {boq.lines.map((l, i) => (
              <tr key={i} className="border-b border-white/5 text-slate-200">
                <td className="py-1 pr-2">{l.item}</td>
                <td className="py-1 pr-2 text-right font-num">{l.qty}</td>
                <td className="py-1 pr-2 text-slate-400">{l.unit}</td>
                <td className="py-1 pr-2 text-right font-num">{l.rate.toLocaleString('en-IN')}</td>
                <td className="py-1 text-right font-num text-teal-200">{fmt(l.amount)}</td>
              </tr>
            ))}
            {!boq.lines.length && (
              <tr><td colSpan={5} className="py-3 text-center text-slate-500">No costed interventions in this design — move Simulator sliders above zero.</td></tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="text-[10px] text-slate-500 mt-1.5">{boq.note}</div>
    </div>
  )
}
