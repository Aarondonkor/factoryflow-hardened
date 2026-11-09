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
import { RollDetailModal } from './RollDetailModal'
import { asRollSearchResult, ROLL_PAGE_SIZE, type InventoryRollRecord } from './rollSearch'

type Tab = 'raw' | 'finished' | 'rolls' | 'movements'

export function InventoryPage() {
  const [tab, setTab] = useState<Tab>('raw')
  const [rawMaterials, setRawMaterials] = useState<RawMaterial[]>([])
  const [finishedGoods, setFinishedGoods] = useState<FinishedGood[]>([])
  const [movements, setMovements] = useState<StockMovement[]>([])
  const [customers, setCustomers] = useState<Customer[]>([])
  const [rolls, setRolls] = useState<ProductRoll[]>([])
  const [rollSearch, setRollSearch] = useState('')
  const [rollQuery, setRollQuery] = useState('')
  const [rollStatus, setRollStatus] = useState('')
  const [rollPage, setRollPage] = useState(0)
  const [rollRefresh, setRollRefresh] = useState(0)
  const [adminRolls, setAdminRolls] = useState<InventoryRollRecord[]>([])
  const [adminRollTotal, setAdminRollTotal] = useState(0)
  const [rollLoading, setRollLoading] = useState(false)
  const [rollError, setRollError] = useState<string | null>(null)
  const [selectedRoll, setSelectedRoll] = useState<InventoryRollRecord | null>(null)
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
      isAdmin ? Promise.resolve({ data: [] as ProductRoll[], error: null }) : supabase.from('product_rolls').select('*').order('roll_no', { ascending: false }).limit(500),
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

  useEffect(() => {
    const timer = window.setTimeout(() => setRollQuery(rollSearch.trim()), 300)
    return () => window.clearTimeout(timer)
  }, [rollSearch])

  useEffect(() => {
    if (!isAdmin || tab !== 'rolls') return
    let active = true
    const load = async () => {
      setRollLoading(true)
      setRollError(null)
      const { data, error } = await supabase.rpc('search_inventory_rolls', {
        p_search: rollQuery,
        p_status: rollStatus || null,
        p_limit: ROLL_PAGE_SIZE,
        p_offset: rollPage * ROLL_PAGE_SIZE,
      })
      if (!active) return
      if (error) {
        setRollError(error.message)
      } else {
        try {
          const result = asRollSearchResult(data)
          setAdminRolls(result.rows)
          setAdminRollTotal(result.total)
          // Handle a page becoming empty after concurrent stock changes.
          if (rollPage > 0 && rollPage * ROLL_PAGE_SIZE >= result.total) setRollPage(0)
        } catch (err) {
          setRollError(err instanceof Error ? err.message : 'Unable to read roll search results')
        }
      }
      setRollLoading(false)
    }
    void load()
    return () => { active = false }
  }, [isAdmin, tab, rollQuery, rollStatus, rollPage, rollRefresh])

  useAutoRefresh(() => { void fetchData(true); setRollRefresh(value => value + 1) }, 60000)

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
          {isAdmin && (
            <div className="mb-5 space-y-3 rounded-xl border border-slate-200 bg-slate-50/70 p-4">
              <div className="flex flex-col gap-3 md:flex-row md:items-end">
                <div className="flex-1">
                  <label htmlFor="admin-roll-search" className="label">Search branded rolls</label>
                  <input
                    id="admin-roll-search"
                    type="search"
                    className="input"
                    placeholder="Brand, customer, product, batch ID, date or roll number"
                    value={rollSearch}
                    maxLength={120}
                    onChange={(event) => { setRollSearch(event.target.value); setRollPage(0) }}
                  />
                </div>
                <div className="md:w-44">
                  <label htmlFor="admin-roll-status" className="label">Roll status</label>
                  <select id="admin-roll-status" className="input" value={rollStatus}
                    onChange={event => { setRollStatus(event.target.value); setRollPage(0) }}>
                    <option value="">All statuses</option>
                    <option value="available">Available</option>
                    <option value="reserved">Reserved</option>
                    <option value="sold">Sold</option>
                    <option value="consumed">Consumed</option>
                  </select>
                </div>
                <Button variant="secondary" onClick={() => setRollRefresh(value => value + 1)}>
                  Refresh
                </Button>
              </div>
              <p className="text-xs text-slate-500">
                Search covers all recorded rolls, not only the most recent 500. Match branded product names,
                assigned customer businesses, batch IDs, production dates (YYYY-MM-DD) or roll numbers.
              </p>
            </div>
          )}
          <p className="text-xs text-slate-500 mb-3" aria-live="polite">
            {isAdmin
              ? `Showing ${adminRolls.length} of ${adminRollTotal} matching rolls${adminRollTotal ? ` · Page ${rollPage + 1} of ${Math.ceil(adminRollTotal / ROLL_PAGE_SIZE)}` : ''}. Status totals below reflect this page.`
              : 'Showing up to the latest 500 individual rolls; summaries below reflect this page.'}
          </p>
          {rollError && isAdmin ? (
            <div role="alert" className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
              Roll search unavailable: {rollError}. Check that database migration 022 is applied.
              <div className="mt-2"><Button variant="secondary" onClick={() => setRollRefresh(value => value + 1)}>Retry</Button></div>
            </div>
          ) : null}
          {(() => {
            const visibleRolls = isAdmin ? adminRolls : rolls
            return <>
              <div className="mb-4 grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
                {(['available', 'reserved', 'sold', 'consumed'] as const).map(st => {
                  const matching = visibleRolls.filter(roll => roll.status === st)
                  return <div key={st} className="rounded-xl bg-slate-50 p-3">
                    <p className="text-xs capitalize text-slate-500">{st}</p>
                    <p className="font-semibold text-slate-900">{matching.length} rolls</p>
                    <p className="text-xs text-slate-500">{formatKg(matching.reduce((total, roll) => total + Number(roll.weight_kg), 0))}</p>
                  </div>
                })}
              </div>
              {isAdmin && rollLoading ? <LoadingSpinner className="py-8" /> : !rollError && (
                <ResponsiveTable
                  headers={['Roll #', 'Product / Brand', 'Batch ID', 'Production date', 'Weight', 'Micron', 'Status', 'Actions']}
                  isEmpty={visibleRolls.length === 0}
                  emptyMessage={isAdmin
                    ? 'No rolls match your search. Try another brand, batch ID, or status.'
                    : 'No individual rolls yet. They appear when a printing run is logged with roll weights.'}
                >
                  {visibleRolls.map(roll => {
                    const product = finishedGoods.find(g => g.id === roll.finished_good_id)
                    const details = isAdmin ? roll as InventoryRollRecord : null
                    const name = details?.product_name || product?.product_name || 'Unknown product'
                    return <TableRow key={roll.id} cells={[
                      isAdmin && details
                        ? <button type="button" className="font-semibold text-brand-800 hover:underline focus-visible:underline" onClick={() => setSelectedRoll(details)}>#{roll.roll_no}</button>
                        : `#${roll.roll_no}`,
                      <div><p className="font-medium">{name}</p>{details?.brand_name && <p className="text-xs text-slate-500">{details.brand_name}</p>}</div>,
                      details?.batch_id || '—',
                      details?.production_date ? formatDate(details.production_date) : '—',
                      formatKg(Number(roll.weight_kg)),
                      roll.micron != null ? `${roll.micron}µ` : '—',
                      <Badge variant={roll.status === 'available' ? 'success' : roll.status === 'reserved' ? 'warning' : 'default'}>{roll.status}</Badge>,
                      isAdmin && details ? <Button variant="secondary" onClick={() => setSelectedRoll(details)}>View details</Button> : null,
                    ]} mobileCard={
                      <div className="space-y-2 text-sm">
                        <div className="flex items-start justify-between gap-3">
                          <div><p className="font-semibold">#{roll.roll_no} · {name}</p>{details?.brand_name && <p className="text-xs text-slate-500">{details.brand_name}</p>}</div>
                          <span className="whitespace-nowrap">{formatKg(Number(roll.weight_kg))}</span>
                        </div>
                        {details && <p className="text-xs text-slate-500">Batch: {details.batch_id || 'Not recorded'} · Produced: {details.production_date ? formatDate(details.production_date) : 'Not recorded'}</p>}
                        <Badge variant={roll.status === 'available' ? 'success' : roll.status === 'reserved' ? 'warning' : 'default'}>{roll.status}</Badge>
                        {isAdmin && details && <Button variant="secondary" className="w-full" onClick={() => setSelectedRoll(details)}>View roll details</Button>}
                      </div>
                    } />
                  })}
                </ResponsiveTable>
              )}
            </>
          })()}
          {isAdmin && !rollError && adminRollTotal > ROLL_PAGE_SIZE && (
            <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-4">
              <p className="text-xs text-slate-500">{rollPage * ROLL_PAGE_SIZE + 1}–{Math.min((rollPage + 1) * ROLL_PAGE_SIZE, adminRollTotal)} of {adminRollTotal} rolls</p>
              <div className="flex gap-2">
                <Button variant="secondary" disabled={rollLoading || rollPage === 0} onClick={() => setRollPage(page => page - 1)}>Previous</Button>
                <Button variant="secondary" disabled={rollLoading || (rollPage + 1) * ROLL_PAGE_SIZE >= adminRollTotal} onClick={() => setRollPage(page => page + 1)}>Next</Button>
              </div>
            </div>
          )}
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

      {isAdmin && <RollDetailModal roll={selectedRoll} onClose={() => setSelectedRoll(null)} />}

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
