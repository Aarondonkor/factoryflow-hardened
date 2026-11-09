import { useCallback, useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { useAutoRefresh } from '@/hooks/useAutoRefresh'
import { useAuthStore } from '@/stores/authStore'
import { useToastStore } from '@/stores/toastStore'
import type { RawMaterial, FinishedGood, StockMovement, Customer, ProductRoll } from '@/types/database'
import { formatDate, formatNumber, formatCurrency, formatKg } from '@/lib/format'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Badge, getStockBadge } from '@/components/ui/Badge'
import { ResponsiveTable, TableRow } from '@/components/ui/Table'
import { LoadingSpinner } from '@/components/ui/LoadingSpinner'
import { PageTabs } from '@/components/ui/PageTabs'
import { StockAdjustModal } from './StockAdjustModal'
import { MaterialFormModal } from './MaterialFormModal'
import { RollReconcileModal } from './RollReconcileModal'

type Tab = 'raw' | 'finished' | 'rolls' | 'movements'

export function InventoryPage() {
  const [tab, setTab] = useState<Tab>('raw')
  const [rawMaterials, setRawMaterials] = useState<RawMaterial[]>([])
  const [finishedGoods, setFinishedGoods] = useState<FinishedGood[]>([])
  const [movements, setMovements] = useState<StockMovement[]>([])
  const [customers, setCustomers] = useState<Customer[]>([])
  const [rolls, setRolls] = useState<ProductRoll[]>([])
  const [loading, setLoading] = useState(true)
  const [fetchError,setFetchError]=useState<string | null>(null)
  const [discrepancies,setDiscrepancies]=useState<Record<string,number>>({})
  const [reconcileId,setReconcileId]=useState<string | null>(null)
  const [adjustModal, setAdjustModal] = useState<{ type: 'raw' | 'finished'; id: string; name: string } | null>(null)
  const [formModal, setFormModal] = useState<'raw' | 'finished' | null>(null)

  const isAdmin = useAuthStore((s) => s.hasRole('admin'))
  const addToast = useToastStore((s) => s.addToast)

  const fetchData = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    const [rawRes, finRes, movRes, custRes, rollRes] = await Promise.all([
      supabase.from('raw_materials').select('*').order('name').limit(500),
      supabase.from('finished_goods').select('*').order('product_name').limit(500),
      supabase.from('stock_movements').select('*').order('created_at', { ascending: false }).limit(100),
      supabase.from('customers').select('*').order('name').limit(500),
      supabase.from('product_rolls').select('*').order('roll_no', { ascending: false }).limit(500),
    ])

    const failed=[rawRes,finRes,movRes,custRes,rollRes].find(r=>r.error)
    if(failed?.error){setFetchError(failed.error.message);if(!silent)setLoading(false);return}
    setFetchError(null)
    setRawMaterials(rawRes.data||[])
    setFinishedGoods(finRes.data||[])
    setMovements(movRes.data||[])
    setCustomers(custRes.data||[])
    setRolls(rollRes.data||[])
    if(isAdmin){
      const {data,error}=await supabase.from('roll_stock_discrepancies').select('id,recorded_stock,counted_rolls')
      if(error){setFetchError(error.message);if(!silent)setLoading(false);return}
      setDiscrepancies(Object.fromEntries((data||[]).map(d=>[d.id,Number(d.recorded_stock)-Number(d.counted_rolls)])))
    }
    if (!silent) setLoading(false)
  },[isAdmin])

  useEffect(() => {
    void fetchData()
  }, [fetchData])

  useAutoRefresh(() => fetchData(true), 60000)

  const toggleOrderable = async (id: string, next: boolean) => {
    const { error } = await supabase.from('finished_goods').update({ customer_orderable: next }).eq('id', id)
    if (error) addToast(error.message, 'error')
    else {
      addToast(next ? 'Product visible to customers' : 'Product hidden from customer portal')
      fetchData()
    }
  }

  const lowStockCount = rawMaterials.filter(
    (m) => m.reorder_threshold > 0 && m.current_stock <= m.reorder_threshold
  ).length

  const tabs = [
    { id: 'raw' as const, label: 'Raw Materials' },
    { id: 'finished' as const, label: 'Finished Goods' },
    { id: 'rolls' as const, label: 'Individual Rolls' },
    { id: 'movements' as const, label: 'Stock History' },
  ]

  if (loading) return <LoadingSpinner className="py-20" />
  if (fetchError) return <Card title="Inventory unavailable"><p role="alert" className="text-red-700">{fetchError}</p><Button onClick={()=>fetchData()}>Retry</Button></Card>

  return (
    <div className="page-shell space-y-6">
      {lowStockCount > 0 && (
        <div className="flex items-center gap-3 rounded-2xl border border-red-200/80 bg-gradient-to-r from-red-50 to-white px-5 py-4 shadow-sm">
          <Badge variant="danger">{lowStockCount} Low Stock</Badge>
          <span className="text-sm font-medium text-red-800">
            {lowStockCount} raw material(s) below reorder threshold
          </span>
        </div>
      )}

      <PageTabs
        tabs={tabs}
        active={tab}
        onChange={(id) => setTab(id as Tab)}
        action={
          isAdmin && (tab === 'raw' || tab === 'finished') ? (
            <Button
              variant="secondary"
              onClick={() => setFormModal(tab === 'raw' ? 'raw' : 'finished')}
            >
              + Add {tab === 'raw' ? 'Material' : 'Product'}
            </Button>
          ) : undefined
        }
      />

      {tab === 'raw' && (
        <Card title="Raw Materials">
          <ResponsiveTable
            headers={['Name', 'Stock', 'Threshold', 'Supplier', 'Last Restock', 'Actions']}
            isEmpty={rawMaterials.length === 0}
          >
            {rawMaterials.map((m) => (
              <TableRow
                key={m.id}
                cells={[
                  m.name,
                  <Badge variant={getStockBadge(m.current_stock, m.reorder_threshold)}>
                    {formatNumber(m.current_stock)} {m.unit}
                  </Badge>,
                  `${formatNumber(m.reorder_threshold)} ${m.unit}`,
                  m.supplier_name || '—',
                  formatDate(m.last_restock_date),
                  isAdmin ? (
                    <Button
                      variant="secondary"
                      onClick={() => setAdjustModal({ type: 'raw', id: m.id, name: m.name })}
                    >
                      Adjust
                    </Button>
                  ) : null,
                ]}
                mobileCard={
                  <div className="space-y-2">
                    <div className="flex justify-between">
                      <span className="font-medium">{m.name}</span>
                      <Badge variant={getStockBadge(m.current_stock, m.reorder_threshold)}>
                        {formatNumber(m.current_stock)} {m.unit}
                      </Badge>
                    </div>
                    <p className="text-xs text-slate-500">Supplier: {m.supplier_name || '—'}</p>
                    {isAdmin && (
                      <Button
                        variant="secondary"
                        className="w-full mt-2"
                        onClick={() => setAdjustModal({ type: 'raw', id: m.id, name: m.name })}
                      >
                        Adjust Stock
                      </Button>
                    )}
                  </div>
                }
              />
            ))}
          </ResponsiveTable>
        </Card>
      )}

      {tab === 'finished' && (
        <Card title="Finished Goods">
          <ResponsiveTable
            headers={['Product', 'Stage', 'Spec', 'Stock', 'List Price', 'Exclusive To', 'Portal', 'Actions']}
            isEmpty={finishedGoods.length === 0}
          >
            {finishedGoods.map((g) => {
              const owner = g.customer_id ? customers.find((c) => c.id === g.customer_id) : null
              return (
                <TableRow
                  key={g.id}
                  cells={[
                    g.product_name,
                    <Badge variant={g.stage === 'semi_finished' ? 'warning' : 'success'}>
                      {g.stage === 'semi_finished' ? 'Semi-Finished' : 'Finished'}
                    </Badge>,
                    `${g.spec_thickness || '—'}µ × ${g.spec_width || '—'}mm ${g.color || ''}`,
                    `${formatNumber(g.current_stock)} ${g.unit === 'bundle' && g.bundle_size ? `bundle (${g.bundle_size}pc)` : g.unit}`,
                    g.unit_price != null ? formatCurrency(g.unit_price) : '—',
                    owner ? (
                      <Badge variant="info">{owner.business_name || owner.name}</Badge>
                    ) : (
                      <span className="text-slate-400 text-xs">All customers</span>
                    ),
                    <Badge variant={g.customer_orderable ? 'success' : 'default'}>
                      {g.customer_orderable ? 'Visible' : 'Hidden'}
                    </Badge>,
                    isAdmin ? (
                      <div className="flex gap-2 flex-wrap">
                        {g.unit!=='rolls' ? <Button variant="secondary"
                          onClick={() => setAdjustModal({ type: 'finished', id: g.id, name: g.product_name })}>
                          Adjust
                        </Button> : (discrepancies[g.id]>0 ? <Button variant="secondary"
                          onClick={() => setReconcileId(g.id)}>Reconcile {discrepancies[g.id]} rolls</Button> : null)}
                        <Button variant="secondary" onClick={() => toggleOrderable(g.id, !g.customer_orderable)}>
                          {g.customer_orderable ? 'Hide from Portal' : 'Show in Portal'}
                        </Button>
                      </div>
                    ) : null,
                  ]}
                  mobileCard={
                    <div className="space-y-2">
                      <div className="flex justify-between">
                        <span className="font-medium">{g.product_name}</span>
                        <span>{formatNumber(g.current_stock)} {g.unit}</span>
                      </div>
                      <div className="flex gap-2 flex-wrap">
                        <Badge variant={g.stage === 'semi_finished' ? 'warning' : 'success'}>
                          {g.stage === 'semi_finished' ? 'Semi-Finished' : 'Finished'}
                        </Badge>
                        {owner && <Badge variant="info">{owner.business_name || owner.name}</Badge>}
                        <Badge variant={g.customer_orderable ? 'success' : 'default'}>
                          {g.customer_orderable ? 'Portal: Visible' : 'Portal: Hidden'}
                        </Badge>
                      </div>
                      <p className="text-xs text-slate-500">{g.warehouse_location}</p>
                      {g.unit_price != null && (
                        <p className="text-xs font-semibold text-slate-700">{formatCurrency(g.unit_price)} / {g.unit==='rolls'?'kg':g.unit}</p>
                      )}
                      {isAdmin && (
                        <Button
                          variant="secondary"
                          className="w-full"
                          onClick={() => toggleOrderable(g.id, !g.customer_orderable)}
                        >
                          {g.customer_orderable ? 'Hide from Portal' : 'Show in Portal'}
                        </Button>
                      )}
                    </div>
                  }
                />
              )
            })}
          </ResponsiveTable>
        </Card>
      )}

      {tab === 'rolls' && (
        <Card title="Individual Rolls">
          <p className="text-xs text-slate-500 mb-3">Showing up to the latest 500 individual rolls; summaries below reflect this page, not all-time inventory.</p>
          <div className="mb-4 grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
            {(['available', 'reserved', 'sold', 'consumed'] as const).map((st) => {
              const list = rolls.filter((r) => r.status === st)
              return (
                <div key={st} className="rounded-xl bg-slate-50 p-3">
                  <p className="text-xs capitalize text-slate-500">{st}</p>
                  <p className="font-semibold text-slate-900">{list.length} rolls</p>
                  <p className="text-xs text-slate-500">{formatKg(list.reduce((s, r) => s + r.weight_kg, 0))}</p>
                </div>
              )
            })}
          </div>
          <ResponsiveTable
            headers={['Roll #', 'Product', 'Weight', 'Micron', 'Status', 'Logged']}
            isEmpty={rolls.length === 0}
            emptyMessage="No individual rolls yet. They appear when a printing run is logged with roll weights."
          >
            {rolls.map((r) => {
              const product = finishedGoods.find((g) => g.id === r.finished_good_id)
              return (
                <TableRow
                  key={r.id}
                  cells={[
                    `#${r.roll_no}`,
                    product?.product_name || '—',
                    formatKg(r.weight_kg),
                    r.micron ? `${r.micron}µ` : '—',
                    <Badge variant={r.status === 'available' ? 'success' : r.status === 'reserved' ? 'warning' : 'default'}>
                      {r.status}
                    </Badge>,
                    formatDate(r.created_at),
                  ]}
                  mobileCard={
                    <div className="space-y-1 text-sm">
                      <div className="flex justify-between">
                        <span className="font-medium">#{r.roll_no} · {product?.product_name || '—'}</span>
                        <span>{formatKg(r.weight_kg)}</span>
                      </div>
                      <p className="text-xs text-slate-500">{r.status}{r.micron ? ` · ${r.micron}µ` : ''}</p>
                    </div>
                  }
                />
              )
            })}
          </ResponsiveTable>
        </Card>
      )}

      {tab === 'movements' && (
        <Card title="Stock Movement History">
          <ResponsiveTable
            headers={['Date', 'Type', 'Material', 'In/Out', 'Qty', 'Source', 'Reason']}
            isEmpty={movements.length === 0}
          >
            {movements.map((m) => {
              const materialName =
                m.material_type === 'raw'
                  ? rawMaterials.find((r) => r.id === m.material_id)?.name
                  : finishedGoods.find((f) => f.id === m.material_id)?.product_name

              return (
                <TableRow
                  key={m.id}
                  cells={[
                    formatDate(m.created_at),
                    m.material_type === 'raw' ? 'Raw' : 'Finished',
                    materialName || m.material_id.slice(0, 8),
                    <Badge variant={m.movement_type === 'in' ? 'success' : 'warning'}>
                      {m.movement_type.toUpperCase()}
                    </Badge>,
                    formatNumber(m.quantity),
                    m.source.replace('_', ' '),
                    m.reason || '—',
                  ]}
                  mobileCard={
                    <div className="space-y-1 text-sm">
                      <div className="flex justify-between">
                        <span className="font-medium">{materialName}</span>
                        <Badge variant={m.movement_type === 'in' ? 'success' : 'warning'}>
                          {m.movement_type} {formatNumber(m.quantity)}
                        </Badge>
                      </div>
                      <p className="text-xs text-slate-500">{formatDate(m.created_at)} · {m.source}</p>
                    </div>
                  }
                />
              )
            })}
          </ResponsiveTable>
        </Card>
      )}

      {reconcileId && (()=>{
        const product=finishedGoods.find(f=>f.id===reconcileId)
        return product ? <RollReconcileModal productId={product.id} name={product.product_name}
          missing={discrepancies[product.id]||0} onClose={()=>setReconcileId(null)}
          onSuccess={()=>{setReconcileId(null);fetchData();addToast('Physical roll records reconciled')}}/> : null
      })()}

      {adjustModal && (
        <StockAdjustModal
          materialType={adjustModal.type}
          materialId={adjustModal.id}
          materialName={adjustModal.name}
          onClose={() => setAdjustModal(null)}
          onSuccess={() => {
            setAdjustModal(null)
            fetchData()
            addToast('Stock adjusted successfully')
          }}
        />
      )}

      {formModal && (
        <MaterialFormModal
          type={formModal}
          customers={customers}
          onClose={() => setFormModal(null)}
          onSuccess={() => {
            setFormModal(null)
            fetchData()
            addToast('Record created successfully')
          }}
        />
      )}
    </div>
  )
}
