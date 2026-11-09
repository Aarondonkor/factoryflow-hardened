import { useCallback, useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { useAutoRefresh } from '@/hooks/useAutoRefresh'
import { formatCurrency, formatNumber, toInputDate } from '@/lib/format'
import { Card, StatCard } from '@/components/ui/Card'
import { PageHeader } from '@/components/ui/PageHeader'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { LoadingSpinner } from '@/components/ui/LoadingSpinner'
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  LineChart, Line } from 'recharts'

interface Summary {
  output_kg?: number
  roll_count?: number
  input_kg?: number
  yield_percent?: number
  waste_percent?: number
  downtime_hours?: number
  monthly_receipts?: number
  outstanding?: number
  low_stock_count?: number
  active_employees?: number
  today_attendance?: number
}
interface Trends {
  production_by_day?: {date:string,output:number}[]
  revenue_by_month?: {month:string,revenue:number}[]
  low_stock_items?: {name:string,stock:number,threshold:number}[]
}

export function DashboardPage() {
  const [summary,setSummary] = useState<Summary | null>(null)
  const [trends,setTrends] = useState<Trends>({})
  const [error,setError] = useState<string | null>(null)
  const [loading,setLoading] = useState(true)
  const profile = useAuthStore(s=>s.profile)
  const fetchDashboard = useCallback(async () => {
    const [{data:metric,error:metricError},{data:trend,error:trendError}]=await Promise.all([
      supabase.rpc('dashboard_metrics',{p_month:toInputDate()}),
      supabase.rpc('dashboard_trends'),
    ])
    if (metricError || trendError) {setError(metricError?.message||trendError?.message||'Unable to load dashboard');setLoading(false);return}
    setSummary(metric as Summary)
    setTrends(trend as Trends)
    setError(null)
    setLoading(false)
  },[])
  useEffect(()=>{fetchDashboard()},[fetchDashboard])
  useAutoRefresh(fetchDashboard,90000)
  if (loading) return <LoadingSpinner className="py-20" />
  if (error || !summary) return <Card title="Dashboard unavailable">
    <p role="alert" className="text-red-700">{error || 'No dashboard data'}</p>
    <Button onClick={fetchDashboard}>Retry</Button>
  </Card>
  const production = summary.output_kg!==undefined
  const sales = summary.monthly_receipts!==undefined
  const inventory = summary.low_stock_count!==undefined
  const hr = summary.active_employees!==undefined
  return <div className="page-shell space-y-6">
    <PageHeader userName={profile?.full_name} subtitle="Production, inventory, sales and HR — calculated from verified ledger activity." />
    {(trends.low_stock_items?.length||0)>0 && <Card title="Low Stock Alerts">
      <Badge variant="warning">{trends.low_stock_items?.length} materials at or below threshold</Badge>
      <div className="flex flex-wrap gap-2 mt-3">{trends.low_stock_items?.map(m=><span key={m.name}
        className="rounded-lg border bg-amber-50 px-3 py-1.5 text-xs">{m.name}: {formatNumber(m.stock)} / {formatNumber(m.threshold)}</span>)}</div>
    </Card>}
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
      {production && <>
        <StatCard label="Extrusion Output" value={`${formatNumber(summary.output_kg||0)} kg`} subtext="Measured kg this month" />
        <StatCard label="Roll Output" value={formatNumber(summary.roll_count||0,0)} subtext="Physical rolls this month" />
        <StatCard label="Material Yield" value={`${formatNumber(summary.yield_percent||0,1)}%`} subtext={`${formatNumber(summary.input_kg||0)} kg formula input`} />
        <StatCard label="Waste Rate" value={`${formatNumber(summary.waste_percent||0,1)}%`} />
        <StatCard label="Downtime" value={`${formatNumber(summary.downtime_hours||0,1)} hrs`} subtext="This month" />
      </>}
      {sales && <>
        <StatCard label="Net Receipts" value={formatCurrency(summary.monthly_receipts||0)} subtext="This month · by payment date" />
        <StatCard label="Outstanding" value={formatCurrency(summary.outstanding||0)} alert={(summary.outstanding||0)>0} />
      </>}
      {inventory && <StatCard label="Low Stock Items" value={summary.low_stock_count||0} alert={(summary.low_stock_count||0)>0} />}
      {hr && <><StatCard label="Active Staff" value={summary.active_employees||0} />
        <StatCard label="Today's Attendance" value={summary.today_attendance||0} /></>}
    </div>
    <div className="grid lg:grid-cols-2 gap-6">
      {(trends.production_by_day||[]).length>0 && <Card title="Extrusion Output (kg, last 14 days)">
        <ResponsiveContainer width="100%" height={250}><BarChart data={trends.production_by_day}>
          <CartesianGrid strokeDasharray="3 3" /><XAxis dataKey="date" fontSize={12}/><YAxis fontSize={12}/><Tooltip/>
          <Bar dataKey="output" fill="#156853" radius={[6,6,0,0]}/>
        </BarChart></ResponsiveContainer>
      </Card>}
      {(trends.revenue_by_month||[]).length>0 && <Card title="Net Receipts by Payment Month">
        <ResponsiveContainer width="100%" height={250}><LineChart data={trends.revenue_by_month}>
          <CartesianGrid strokeDasharray="3 3" /><XAxis dataKey="month" fontSize={12}/><YAxis fontSize={12}/>
          <Tooltip formatter={(v:number)=>formatCurrency(v)}/><Line type="monotone" dataKey="revenue" stroke="#D4A853" strokeWidth={2.5}/>
        </LineChart></ResponsiveContainer>
      </Card>}
    </div>
  </div>
}
