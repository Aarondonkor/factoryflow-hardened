import { useCallback, useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { ResponsiveContainer, CartesianGrid, XAxis, YAxis, Tooltip, Legend, Bar, BarChart, Pie, PieChart, Cell } from 'recharts'
import { supabase } from '@/lib/supabase'
import { formatCurrency, toInputDate } from '@/lib/format'
import { PageHeader } from '@/components/ui/PageHeader'
import { Card, StatCard } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'

type Totals = { gross_receipts: number; refunds: number; expenses: number; net_cashflow: number; outstanding_orders: number }
type Entry = { id: string; type: 'receipt' | 'refund' | 'expense'; date: string; amount: number; detail: string; category: string; reference: string }
type Daily = { date: string; receipts: number; refunds: number; expenses: number; net: number }
type Report = { totals: Totals; daily: Daily[]; entries: Entry[]; expense_categories: { name: string; amount: number }[] }
const categories = ['raw_materials','utilities','transport','payroll','maintenance','rent','taxes','bank_fees','other']
const paymentMethods = ['cash','mobile_money','bank_transfer','other']
const palette = ['#176ca7','#e1a43b','#16a085','#7c68a9','#d35b62','#3a9375','#59729a','#a78b47','#777777']
const display = (s: string) => s.replace(/_/g, ' ').replace(/\b\w/g,(c: string) => c.toUpperCase())
// Excel interprets values beginning with =,+,-,@ as formulas. Neutralize exported text.
const csvCell = (v: string | number) => {
  const text = String(v ?? '')
  const safe = typeof v === 'number' ? text : (/^[\s]*[=+@\-\t\r]/.test(text) ? `'${text}` : text)
  return `"${safe.replace(/"/g, '""')}"`
}
function exportCsv(rows: Entry[]) {
  const columns = ['Date','Type','Amount (GHS)','Description / Order','Category / Method','Reference']
  const csv = [columns.map(csvCell).join(','),...rows.map(r => [r.date,r.type,r.amount,r.detail,r.category,r.reference].map(csvCell).join(','))].join('\r\n')
  const url = URL.createObjectURL(new Blob(['\uFEFF'+csv],{type:'text/csv;charset=utf-8;'}))
  const a = document.createElement('a'); a.href = url; a.download = 'purifa-finance-entries.csv'; a.click()
  URL.revokeObjectURL(url)
}
const emptyExpense = { date: toInputDate(), category: 'raw_materials', description: '', amount: '', paid_via: 'mobile_money', reference: '' }

export function FinancePage() {
  const today = toInputDate()
  const [start,setStart] = useState(`${today.slice(0,7)}-01`)
  const [end,setEnd] = useState(today)
  const [report,setReport] = useState<Report|null>(null)
  const [expense,setExpense] = useState(emptyExpense)
  const [busy,setBusy] = useState(false)
  const [loading,setLoading] = useState(false)
  const [error,setError] = useState('')
  const [notice,setNotice] = useState('')
  const fetchReport = useCallback(async()=>{
    setLoading(true);setError('')
    const { data, error:err } = await supabase.rpc('finance_report',{p_start:start,p_end:end})
    if(err) setError(err.message)
    else setReport(data as unknown as Report)
    setLoading(false)
  },[start,end])
  useEffect(()=>{void fetchReport()},[fetchReport])
  const totals = report?.totals
  const chartRows = useMemo(() => report?.daily ?? [],[report])
  const saveExpense = async (ev: FormEvent<HTMLFormElement>) => {
    ev.preventDefault();setBusy(true);setError('');setNotice('')
    const amount = Number(expense.amount)
    if(!Number.isFinite(amount)||amount<=0){setError('Enter an expense amount greater than zero.');setBusy(false);return}
    const {error:err} = await supabase.rpc('finance_record_expense',{
      p_date:expense.date,p_category:expense.category,p_description:expense.description,
      p_amount:amount,p_paid_via:expense.paid_via,p_reference:expense.reference || null,
    })
    if(err) setError(err.message)
    else {setNotice('Expense recorded in the finance ledger.');setExpense({...emptyExpense,date:expense.date});await fetchReport()}
    setBusy(false)
  }
  return <div className="page-shell space-y-6">
    <PageHeader title="Accounting & Finance" subtitle="GHS cashflow, verified ledger receipts, expenses and customer balances" />
    <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950">
      Receipts reflect recorded customer payments, not Paystack-to-MoMo payouts. Net cashflow is receipts minus refunds and logged expenses; it is not accounting profit. Outstanding balances are current, not limited to the selected dates.
    </div>
    <div className="flex flex-wrap items-end gap-3 rounded-xl bg-white p-4 shadow-sm">
      <label className="text-sm font-semibold">From <input aria-label="Report start date" className="mt-1 block rounded-lg border p-2" type="date" value={start} onChange={e=>setStart(e.target.value)}/></label>
      <label className="text-sm font-semibold">To <input aria-label="Report end date" className="mt-1 block rounded-lg border p-2" type="date" value={end} onChange={e=>setEnd(e.target.value)}/></label>
      <Button onClick={()=>void fetchReport()} disabled={loading}>{loading?'Loading...':'Refresh report'}</Button>
      <Button variant="secondary" disabled={!report?.entries?.length} onClick={()=>exportCsv(report?.entries??[])}>Export Excel CSV</Button>
    </div>
    {error&&<p role="alert" className="rounded-lg bg-red-50 p-3 text-red-700">{error}</p>}
    {notice&&<p role="status" className="rounded-lg bg-emerald-50 p-3 text-emerald-800">{notice}</p>}
    {totals && <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
      <StatCard label="Received payments" value={formatCurrency(Number(totals.gross_receipts))} subtext="Recorded payments in selected dates"/>
      <StatCard label="Refunds" value={formatCurrency(Number(totals.refunds))}/>
      <StatCard label="Expenses" value={formatCurrency(Number(totals.expenses))}/>
      <StatCard label="Net cashflow" value={formatCurrency(Number(totals.net_cashflow))} subtext="Not net profit"/>
      <StatCard label="Customer receivables" value={formatCurrency(Number(totals.outstanding_orders))} subtext="Current outstanding order amounts"/>
    </div>}
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="Receipts, refunds & expenses by day">
        <div className="h-72 w-full" aria-label="Daily finance chart">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartRows} margin={{top:12,right:10,left:4,bottom:28}}>
              <CartesianGrid strokeDasharray="3 3"/><XAxis dataKey="date" tick={{fontSize:10}} angle={-30} textAnchor="end" height={55}/><YAxis tick={{fontSize:11}}/>
              <Tooltip formatter={(v)=>formatCurrency(Number(v??0))}/><Legend/>
              <Bar dataKey="receipts" name="Receipts" fill="#176ca7"/><Bar dataKey="refunds" name="Refunds" fill="#d35b62"/><Bar dataKey="expenses" name="Expenses" fill="#e1a43b"/>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </Card>
      <Card title="Expenses by category">
        {report?.expense_categories?.length ? <div className="h-72 w-full">
          <ResponsiveContainer width="100%" height="100%"><PieChart><Pie data={report.expense_categories} dataKey="amount" nameKey="name" outerRadius={90} label={({name})=>display(String(name))}>
            {report.expense_categories.map((x,i)=><Cell key={x.name} fill={palette[i%palette.length]}/>)}</Pie>
            <Tooltip formatter={v=>formatCurrency(Number(v??0))}/></PieChart></ResponsiveContainer>
        </div> : <p className="py-16 text-center text-sm text-slate-500">No expenses recorded in this period.</p>}
      </Card>
    </div>
    <Card title="Record business expense">
      <form className="grid grid-cols-1 gap-3 md:grid-cols-3" onSubmit={e=>void saveExpense(e)}>
        <label className="text-sm">Expense date<input type="date" required max={today} min="2000-01-01" value={expense.date} onChange={e=>setExpense(v=>({...v,date:e.target.value}))} className="mt-1 w-full rounded-lg border p-2"/></label>
        <label className="text-sm">Category<select value={expense.category} onChange={e=>setExpense(v=>({...v,category:e.target.value}))} className="mt-1 w-full rounded-lg border p-2">{categories.map(c=><option key={c} value={c}>{display(c)}</option>)}</select></label>
        <label className="text-sm">Amount (GHS)<input type="number" required min="0.01" max="100000000" step="0.01" value={expense.amount} onChange={e=>setExpense(v=>({...v,amount:e.target.value}))} className="mt-1 w-full rounded-lg border p-2"/></label>
        <label className="text-sm md:col-span-2">Description<input required minLength={3} maxLength={500} value={expense.description} onChange={e=>setExpense(v=>({...v,description:e.target.value}))} className="mt-1 w-full rounded-lg border p-2" placeholder="e.g. Factory electricity bill"/></label>
        <label className="text-sm">Paid by<select value={expense.paid_via} onChange={e=>setExpense(v=>({...v,paid_via:e.target.value}))} className="mt-1 w-full rounded-lg border p-2">{paymentMethods.map(m=><option key={m} value={m}>{display(m)}</option>)}</select></label>
        <label className="text-sm md:col-span-2">Receipt / reference (optional)<input maxLength={120} value={expense.reference} onChange={e=>setExpense(v=>({...v,reference:e.target.value}))} className="mt-1 w-full rounded-lg border p-2" placeholder="MoMo / bank transaction reference"/></label>
        <div className="flex items-end"><Button disabled={busy} type="submit">{busy?'Saving...':'Save expense'}</Button></div>
      </form>
    </Card>
    <Card title="Financial transaction history (latest 2,000 in period)">
      <div className="overflow-x-auto"><table className="min-w-full text-left text-sm"><thead><tr className="border-b text-slate-500"><th className="p-2">Date</th><th className="p-2">Type</th><th className="p-2">Description / Order</th><th className="p-2">Method / Category</th><th className="p-2 text-right">Amount (GHS)</th></tr></thead>
        <tbody>{report?.entries?.map(e=><tr key={`${e.type}-${e.id}`} className="border-b"><td className="p-2 whitespace-nowrap">{e.date}</td><td className="p-2">{display(e.type)}</td><td className="p-2">{e.detail}</td><td className="p-2">{display(e.category||'')}</td><td className={`p-2 text-right font-semibold ${Number(e.amount)<0?'text-red-700':'text-emerald-700'}`}>{formatCurrency(Number(e.amount))}</td></tr>)}
          {!report?.entries?.length&&<tr><td className="p-4 text-center text-slate-500" colSpan={5}>No transactions recorded in this period.</td></tr>}</tbody></table></div>
    </Card>
  </div>
}

