import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { useAutoRefresh } from '@/hooks/useAutoRefresh'
import { useAuthStore } from '@/stores/authStore'
import { useToastStore } from '@/stores/toastStore'
import type { ProductionRun, MachineDowntime, Machine, RawMaterial, FinishedGood } from '@/types/database'
import { formatDate, formatNumber, SHIFT_LABELS } from '@/lib/format'
import { Card, StatCard } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { ResponsiveTable, TableRow } from '@/components/ui/Table'
import { LoadingSpinner } from '@/components/ui/LoadingSpinner'
import { PageTabs } from '@/components/ui/PageTabs'
import { ProductionRunForm } from './ProductionRunForm'
import { DowntimeForm } from './DowntimeForm'

type Tab = 'runs' | 'downtime' | 'summary'

export function ProductionPage() {
  const [tab, setTab] = useState<Tab>('runs')
  const [runs, setRuns] = useState<ProductionRun[]>([])
  const [downtimes, setDowntimes] = useState<MachineDowntime[]>([])
  const [machines, setMachines] = useState<Machine[]>([])
  const [rawMaterials, setRawMaterials] = useState<RawMaterial[]>([])
  const [finishedGoods, setFinishedGoods] = useState<FinishedGood[]>([])
  const [loading, setLoading] = useState(true)
  const [fetchError,setFetchError] = useState<string | null>(null)
  const [showRunForm, setShowRunForm] = useState(false)
  const [showDowntimeForm, setShowDowntimeForm] = useState(false)

  const canWrite = useAuthStore((s) => s.hasRole('admin', 'production_supervisor'))
  const addToast = useToastStore((s) => s.addToast)

  const fetchData = async (silent = false) => {
    if (!silent) setLoading(true)
    const [runsRes, dtRes, machRes, rawRes, finRes] = await Promise.all([
      supabase
        .from('production_runs')
        .select(
          '*, machines(machine_code, name, stage), finished_goods:finished_goods!production_runs_finished_good_id_fkey(product_name, stage), input_product:finished_goods!production_runs_input_product_id_fkey(product_name), production_run_materials(quantity_kg, raw_materials(name))'
        )
        .order('run_date', { ascending: false })
        .limit(50),
      supabase
        .from('machine_downtime')
        .select('*, machines(machine_code, name)')
        .order('start_time', { ascending: false })
        .limit(50),
      supabase.from('machines').select('*').eq('is_active', true),
      supabase.from('raw_materials').select('*').order('name'),
      supabase.from('finished_goods').select('*').order('product_name'),
    ])

    const failed=[runsRes,dtRes,machRes,rawRes,finRes].find(r=>r.error)
    if(failed?.error) {
      setFetchError(failed.error.message)
      if(!silent) setLoading(false)
      return
    }
    setFetchError(null)
    setRuns(runsRes.data || [])
    setDowntimes(dtRes.data || [])
    setMachines(machRes.data || [])
    setRawMaterials(rawRes.data || [])
    setFinishedGoods(finRes.data || [])
    if (!silent) setLoading(false)
  }

  useEffect(() => {
    fetchData()
  }, [])

  useAutoRefresh(() => fetchData(true), 60000)

  const extrusionRuns=runs.filter(r=>(r.machines as Machine)?.stage === 'extrusion')
  const totalOutputKg=extrusionRuns.reduce((sum,r)=>sum + (r.output_unit==='kg'
    ? r.output_quantity : (r.roll_weights||[]).reduce((s,kg)=>s+kg,0)),0)
  const totalRolls=runs.filter(r=>r.output_unit==='rolls').reduce((sum,r)=>sum+r.output_quantity,0)
  const totalWaste=extrusionRuns.reduce((sum,r)=>sum+r.waste_quantity,0)
  const totalInput=extrusionRuns.reduce((sum,r)=>sum+(r.production_run_materials||[]).reduce((s,m)=>s+m.quantity_kg,0),0)
  const yieldPercent=totalInput>0?totalOutputKg*100/totalInput:0
  const wastePercent=totalInput>0?totalWaste*100/totalInput:0
  const totalDowntimeHours = downtimes.reduce(
    (sum, d) => sum + (d.duration_minutes || 0) / 60,
    0
  )

  const tabs = [
    { id: 'runs' as const, label: 'Production Runs' },
    { id: 'downtime' as const, label: 'Downtime Log' },
    { id: 'summary' as const, label: 'Summary' },
  ]

  if (loading) return <LoadingSpinner className="py-20" />
  if (fetchError) return <Card title="Production unavailable"><p role="alert" className="text-red-700">{fetchError}</p><Button onClick={()=>fetchData()}>Retry</Button></Card>

  return (
    <div className="page-shell space-y-6">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="Recent output" value={`${formatNumber(totalOutputKg)} kg`} />
        <StatCard label="Yield %" value={`${formatNumber(yieldPercent, 1)}%`} />
        <StatCard label="Waste %" value={`${formatNumber(wastePercent, 1)}%`} />
        <StatCard label="Downtime" value={`${formatNumber(totalDowntimeHours, 1)} hrs`} />
      </div>

      <p className="text-xs text-slate-500">Production and downtime figures reflect the latest 50 records, not all-time totals. {formatNumber(totalRolls,0)} individual-roll outputs are recorded in this sample. Yield is based on extrusion only.</p>
      <PageTabs
        tabs={tabs}
        active={tab}
        onChange={(id) => setTab(id as Tab)}
        action={
          canWrite && tab === 'runs' ? (
            <Button variant="secondary" onClick={() => setShowRunForm(true)}>
              + Log Production Run
            </Button>
          ) : canWrite && tab === 'downtime' ? (
            <Button variant="secondary" onClick={() => setShowDowntimeForm(true)}>
              + Log Downtime
            </Button>
          ) : undefined
        }
      />

      {tab === 'runs' && (
        <Card title="Production Runs">
          <ResponsiveTable
            headers={['Date', 'Shift', 'Machine', 'Operator', 'Product', 'Output', 'Consumed', 'Waste']}
            isEmpty={runs.length === 0}
          >
            {runs.map((r) => {
              const isConversion = (r.machines as Machine)?.stage === 'conversion'
              const materialsTotal = (r.production_run_materials || []).reduce((s, m) => s + m.quantity_kg, 0)
              const consumedLabel = isConversion
                ? `${formatNumber(r.input_quantity_consumed)} ${(r.input_product as FinishedGood)?.product_name || 'input'}`
                : `${formatNumber(materialsTotal)} kg materials`
              return (
                <TableRow
                  key={r.id}
                  cells={[
                    formatDate(r.run_date),
                    SHIFT_LABELS[r.shift],
                    (r.machines as Machine)?.machine_code || '—',
                    r.operator_name,
                    r.finished_goods?.product_name || '—',
                    `${formatNumber(r.output_quantity)} ${r.output_unit}`,
                    consumedLabel,
                    `${formatNumber(r.waste_quantity)} kg`,
                  ]}
                  mobileCard={
                    <div className="space-y-1 text-sm">
                      <div className="flex justify-between font-medium">
                        <span>{formatDate(r.run_date)} · {SHIFT_LABELS[r.shift]}</span>
                        <span>{formatNumber(r.output_quantity)} {r.output_unit}</span>
                      </div>
                      <p className="text-xs text-slate-500">
                        {(r.machines as Machine)?.name} · {r.operator_name}
                      </p>
                      <p className="text-xs text-slate-500">
                        {r.finished_goods?.product_name || '—'} {isConversion ? `← ${(r.input_product as FinishedGood)?.product_name || 'input'}` : ''}
                      </p>
                    </div>
                  }
                />
              )
            })}
          </ResponsiveTable>
        </Card>
      )}

      {tab === 'downtime' && (
        <Card title="Machine Downtime">
          <ResponsiveTable
            headers={['Machine', 'Reason', 'Start', 'End', 'Duration (min)']}
            isEmpty={downtimes.length === 0}
          >
            {downtimes.map((d) => (
              <TableRow
                key={d.id}
                cells={[
                  (d.machines as Machine)?.machine_code || '—',
                  d.reason.replace('_', ' '),
                  formatDate(d.start_time),
                  d.end_time ? formatDate(d.end_time) : 'Ongoing',
                  d.duration_minutes ? formatNumber(d.duration_minutes, 0) : '—',
                ]}
                mobileCard={
                  <div className="space-y-1 text-sm">
                    <div className="flex justify-between">
                      <span className="font-medium">{(d.machines as Machine)?.name}</span>
                      <span>{d.duration_minutes ? `${d.duration_minutes} min` : 'Ongoing'}</span>
                    </div>
                    <p className="text-xs text-slate-500 capitalize">{d.reason.replace('_', ' ')}</p>
                  </div>
                }
              />
            ))}
          </ResponsiveTable>
        </Card>
      )}

      {tab === 'summary' && (
        <div className="grid md:grid-cols-2 gap-6">
          <Card title="Production by Machine">
            {machines.map((m) => {
              const machineRuns = runs.filter((r) => r.machine_id === m.id)
              const outputKg = machineRuns.filter(()=>m.stage==='extrusion').reduce((s,r)=>s+(r.output_unit==='kg' ? r.output_quantity : (r.roll_weights||[]).reduce((x,y)=>x+y,0)),0)
              const rolls=machineRuns.filter(r=>r.output_unit==='rolls').reduce((s,r)=>s+r.output_quantity,0)
              return (
                <div key={m.id} className="flex justify-between py-2 border-b border-slate-100 last:border-0">
                  <span className="text-sm">{m.name}</span>
                  <span className="text-sm font-medium">{m.stage==='extrusion' ? `${formatNumber(outputKg)} kg` : `${formatNumber(rolls,0)} rolls · ${machineRuns.length} runs`}</span>
                </div>
              )
            })}
          </Card>
          <Card title="Recent Activity">
            {runs.slice(0, 5).map((r) => (
              <div key={r.id} className="flex justify-between py-2 border-b border-slate-100 last:border-0 text-sm">
                <span>{formatDate(r.run_date)} · {r.operator_name}</span>
                <span className="font-medium">{formatNumber(r.output_quantity)} {r.output_unit}</span>
              </div>
            ))}
          </Card>
        </div>
      )}

      {showRunForm && (
        <ProductionRunForm
          machines={machines}
          rawMaterials={rawMaterials}
          finishedGoods={finishedGoods}
          onClose={() => setShowRunForm(false)}
          onSuccess={() => {
            setShowRunForm(false)
            fetchData()
            addToast('Production run logged — inventory updated automatically')
          }}
        />
      )}

      {showDowntimeForm && (
        <DowntimeForm
          machines={machines}
          onClose={() => setShowDowntimeForm(false)}
          onSuccess={() => {
            setShowDowntimeForm(false)
            fetchData()
            addToast('Downtime logged')
          }}
        />
      )}
    </div>
  )
}
