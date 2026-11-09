import { useCallback, useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { useAutoRefresh } from '@/hooks/useAutoRefresh'
import { useToastStore } from '@/stores/toastStore'
import type { Customer, FinishedGood, Order, ProductRoll } from '@/types/database'
import { formatItemSpec, formatKg, formatCurrency, formatDate, toInputDate, ORDER_STATUS_LABELS, DELIVERY_STATUS_LABELS } from '@/lib/format'
import { Card, StatCard } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Badge, getOrderStatusBadge, getDeliveryStatusBadge } from '@/components/ui/Badge'
import { ResponsiveTable, TableRow } from '@/components/ui/Table'
import { LoadingSpinner } from '@/components/ui/LoadingSpinner'
import { PageTabs } from '@/components/ui/PageTabs'
import { OrderDetailModal } from '@/components/orders/OrderDetailModal'
import { verifyReturnedPayment } from '@/lib/paystack'

type Tab = 'place-order' | 'my-orders'

interface CartLine {
  finished_good_id: string
  quantity: string
}

function unitLabel(g: FinishedGood) {
  if (g.unit === 'bundle') return g.bundle_size ? `bundle of ${g.bundle_size}` : 'bundle'
  return g.unit
}

export function CustomerPortalPage() {
  const addToast = useToastStore((s) => s.addToast)

  const [tab, setTab] = useState<Tab>('place-order')
  const [company, setCompany] = useState<Customer | null>(null)
  const [products, setProducts] = useState<FinishedGood[]>([])
  const [orders, setOrders] = useState<Order[]>([])
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)

  const [deliveryDate, setDeliveryDate] = useState(toInputDate(new Date(Date.now() + 7 * 86400000)))
  const [notes, setNotes] = useState('')
  const [cart, setCart] = useState<CartLine[]>([{ finished_good_id: '', quantity: '' }])
  const [selectedOrder, setSelectedOrder] = useState<Order | null>(null)
  const [availableRolls, setAvailableRolls] = useState<ProductRoll[]>([])
  const [ownRolls, setOwnRolls] = useState<ProductRoll[]>([])
  const [selectedRollIds, setSelectedRollIds] = useState<string[]>([])
  const [editingOrderId, setEditingOrderId] = useState<string | null>(null)
  const [fetchError, setFetchError] = useState<string | null>(null)

  // Products counted in rolls are bought by picking individual rolls; everything
  // else (bundles, kg products) is a normal quantity line. Price on a roll
  // product is per kg.
  const rollProducts = products.filter((p) => p.unit === 'rolls' && p.unit_price != null)
  const orderableProducts = products.filter((p) => p.unit_price != null && p.unit !== 'rolls')

  const fetchData = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    const [companyRes, productsRes, ordersRes, availRes, ownRes] = await Promise.all([
      supabase.from('customers').select('*').maybeSingle(),
      supabase.from('finished_goods').select('*').order('product_name'),
      supabase
        .from('orders')
        .select('*, order_items(*, finished_goods(product_name, unit))')
        .order('created_at', { ascending: false }),
      supabase.from('product_rolls').select('*').eq('status', 'available').order('roll_no'),
      supabase.from('product_rolls').select('*').not('order_item_id', 'is', null),
    ])

    const failure = [companyRes,productsRes,ordersRes,availRes,ownRes].find(r=>r.error)
    if (failure?.error) { setFetchError(failure.error.message);setLoading(false);return }
    setFetchError(null)
    setCompany(companyRes.data || null)
    setProducts(productsRes.data || [])
    setOrders(ordersRes.data || [])
    setAvailableRolls(availRes.data || [])
    setOwnRolls(ownRes.data || [])
    // Drop any picked roll that someone else has taken since we last looked.
    const stillAvailable = new Set([...(availRes.data || []).map(r=>r.id),
      ...(ownRes.data || []).filter(r=>r.status==='reserved').map(r=>r.id)])
    setSelectedRollIds((prev) => prev.filter((id) => stillAvailable.has(id)))
    if (!silent) setLoading(false)
  },[])

  useEffect(() => {
    void fetchData()
  }, [fetchData])

  useAutoRefresh(() => fetchData(true), 60000)

  useEffect(() => {
    verifyReturnedPayment().then(verified=>{if(verified){addToast('Payment verified by Paystack');fetchData()}})
      .catch(err=>addToast(err instanceof Error ? err.message : 'Payment not verified','error'))
  }, [addToast,fetchData])

  const isApproved = company?.approval_status === 'approved'

  const updateCartLine = (index: number, patch: Partial<CartLine>) => {
    setCart(cart.map((line, i) => (i === index ? { ...line, ...patch } : line)))
  }

  const selectableRolls = [...availableRolls, ...ownRolls.filter(r => r.status === 'reserved' &&
    orders.find(o=>o.id===editingOrderId)?.order_items?.some(i=>i.id===r.order_item_id))]

  const toggleRoll = (id: string) =>
    setSelectedRollIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))

  const setProductRolls = (productId: string, select: boolean) => {
    const ids = selectableRolls.filter((r) => r.finished_good_id === productId).map((r) => r.id)
    setSelectedRollIds((prev) => {
      const rest = prev.filter((id) => !ids.includes(id))
      return select ? [...rest, ...ids] : rest
    })
  }

  const selectedRolls = selectableRolls.filter((r) => selectedRollIds.includes(r.id))
  const selectedKg = selectedRolls.reduce((sum, r) => sum + r.weight_kg, 0)
  const rollsCost = selectedRolls.reduce((sum, r) => {
    const product = products.find((p) => p.id === r.finished_good_id)
    return sum + r.weight_kg * (product?.unit_price || 0)
  }, 0)

  const cartTotal = cart.reduce((sum, line) => {
    const product = products.find((p) => p.id === line.finished_good_id)
    const qty = parseFloat(line.quantity) || 0
    return sum + (product?.unit_price || 0) * qty
  }, 0)

  const orderTotal = cartTotal + rollsCost

  const handleSubmitOrder = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!company) return

    const validLines = cart.filter((l) => l.finished_good_id && parseFloat(l.quantity) > 0)
    if (validLines.length === 0 && selectedRolls.length === 0) {
      addToast('Pick at least one roll, or add a product with a quantity', 'error')
      return
    }

    setSubmitting(true)

    // One atomic call: the order, its lines and the roll reservations are all
    // created together, or not at all (e.g. if someone else just took a roll).
    const { error } = await supabase.rpc('save_customer_order', {
      p_existing_order: editingOrderId,
      p_delivery_date: deliveryDate,
      p_notes: notes || null,
      p_items: validLines.map((l) => ({
        finished_good_id: l.finished_good_id,
        quantity: parseFloat(l.quantity),
      })),
      p_roll_ids: selectedRolls.map((r) => r.id),
    })

    setSubmitting(false)

    if (error) {
      addToast(error.message, 'error')
      fetchData(true)
      return
    }

    addToast(editingOrderId ? 'Pending order updated' : 'Order placed — awaiting confirmation')
    setEditingOrderId(null)
    setCart([{ finished_good_id: '', quantity: '' }])
    setSelectedRollIds([])
    setNotes('')
    setTab('my-orders')
    fetchData()
  }

  const startEditOrder = (order: Order) => {
    if (order.status !== 'pending') return
    const lines = order.order_items || []
    setEditingOrderId(order.id)
    setDeliveryDate(order.delivery_date || toInputDate())
    setNotes(order.notes || '')
    setCart(lines.filter(i=>!ownRolls.some(r=>r.order_item_id===i.id))
      .map(i=>({finished_good_id:i.finished_good_id,quantity:String(i.quantity)})))
    setSelectedRollIds(ownRolls.filter(r=>lines.some(i=>i.id===r.order_item_id)).map(r=>r.id))
    setTab('place-order')
  }

  const cancelPendingOrder = async (order: Order) => {
    if (order.status!=='pending' || !window.confirm(`Cancel ${order.order_number}?`)) return
    const {error}=await supabase.rpc('change_order_state',{p_order:order.id,p_action:'cancel'})
    if (error) addToast(error.message,'error')
    else {addToast('Pending order cancelled');fetchData()}
  }

  // How an order line reads in lists: roll lines show roll count and weight,
  // others show quantity.
  const describeItem = (it: NonNullable<Order['order_items']>[number]) => {
    const itemRolls = ownRolls.filter((r) => r.order_item_id === it.id)
    const name = it.finished_goods?.product_name || 'item'
    if (itemRolls.length > 0) {
      const kg = itemRolls.reduce((sum, r) => sum + r.weight_kg, 0)
      return `${itemRolls.length} roll${itemRolls.length === 1 ? '' : 's'} (${formatKg(kg)}) × ${name}${formatItemSpec(it)}`
    }
    return `${it.quantity} × ${name}${formatItemSpec(it)}`
  }

  if (loading) return <LoadingSpinner className="py-20" />
  if (fetchError) return <Card title="Unable to load orders"><p role="alert" className="text-red-700">{fetchError}</p>
    <Button onClick={()=>fetchData()}>Retry</Button></Card>

  const pendingCount = orders.filter((o) => o.status === 'pending').length

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-2xl font-bold text-slate-900">
          {company?.business_name || company?.name || 'Your Orders'}
        </h1>
        <p className="mt-1 text-sm text-slate-500">Order directly from the factory and track your orders</p>
      </div>

      {!isApproved && (
        <Card className="!p-5 border-amber-300/80 bg-gradient-to-br from-amber-50 to-white">
          <p className="font-semibold text-amber-800">Account pending approval</p>
          <p className="mt-1 text-sm text-amber-700">
            {company?.approval_status === 'rejected'
              ? "Your account request wasn't approved. Please contact us for details."
              : "Our team is reviewing your company details. You'll be notified here as soon as you're approved, and can start ordering right away."}
          </p>
        </Card>
      )}

      <div className="grid grid-cols-2 gap-4">
        <StatCard label="Pending Orders" value={pendingCount} />
        <StatCard label="Total Orders" value={orders.length} />
      </div>

      <PageTabs
        tabs={[
          { id: 'place-order', label: 'Place Order' },
          { id: 'my-orders', label: 'My Orders' },
        ]}
        active={tab}
        onChange={(id) => setTab(id as Tab)}
      />

      {tab === 'place-order' && (
        <Card title={editingOrderId ? "Edit Pending Order" : "Place an Order"}>
          {!isApproved ? (
            <p className="text-sm text-slate-500">You'll be able to place orders once your account is approved.</p>
          ) : orderableProducts.length === 0 && rollProducts.length === 0 ? (
            <p className="text-sm text-slate-500">
              No products are available for online ordering yet. Please contact sales directly.
            </p>
          ) : (
            <form onSubmit={handleSubmitOrder} className="space-y-6">
              {rollProducts.length > 0 && (
                <div className="space-y-4">
                  <div>
                    <p className="text-sm font-semibold text-slate-800">Available rolls</p>
                    <p className="text-xs text-slate-500">
                      Tap the rolls you want. Each roll is priced by its own weight, so you only pay for the
                      rolls you pick.
                    </p>
                  </div>

                  {rollProducts.map((product) => {
                    const productRolls = selectableRolls.filter((r) => r.finished_good_id === product.id)
                    const totalKg = productRolls.reduce((sum, r) => sum + r.weight_kg, 0)
                    const pickedHere = productRolls.filter((r) => selectedRollIds.includes(r.id))
                    const allPicked = productRolls.length > 0 && pickedHere.length === productRolls.length
                    return (
                      <div key={product.id} className="rounded-xl border border-slate-200 p-3 space-y-3">
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <div>
                            <p className="font-semibold text-slate-800">
                              {product.product_name}
                              {product.customer_id ? (
                                <span className="ml-2 text-xs font-normal text-brand-700">your branded product</span>
                              ) : null}
                            </p>
                            <p className="text-xs text-slate-500">
                              {formatCurrency(product.unit_price || 0)} per kg ·{' '}
                              {productRolls.length === 0
                                ? 'no rolls available right now'
                                : `${productRolls.length} roll${productRolls.length === 1 ? '' : 's'} available · ${formatKg(totalKg)} total`}
                            </p>
                          </div>
                          {productRolls.length > 0 && (
                            <Button
                              type="button"
                              variant="secondary"
                              onClick={() => setProductRolls(product.id, !allPicked)}
                            >
                              {allPicked ? 'Clear' : 'Select all'}
                            </Button>
                          )}
                        </div>

                        {productRolls.length > 0 && (
                          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
                            {productRolls.map((r) => {
                              const picked = selectedRollIds.includes(r.id)
                              return (
                                <button
                                  key={r.id}
                                  type="button"
                                  onClick={() => toggleRoll(r.id)}
                                  aria-pressed={picked}
                                  className={`rounded-xl border px-3 py-2 text-left transition-colors ${
                                    picked
                                      ? 'border-brand-600 bg-brand-50 ring-1 ring-brand-600'
                                      : 'border-slate-200 bg-white hover:border-slate-300'
                                  }`}
                                >
                                  <span className="block text-[11px] text-slate-400">Roll #{r.roll_no}</span>
                                  <span className="block text-sm font-semibold text-slate-800">{r.weight_kg} kg</span>
                                  <span className="block text-[11px] text-slate-500">
                                    {r.micron ? `${r.micron}µ · ` : ''}
                                    {formatCurrency(r.weight_kg * (product.unit_price || 0))}
                                  </span>
                                </button>
                              )
                            })}
                          </div>
                        )}
                      </div>
                    )
                  })}

                  {selectedRolls.length > 0 && (
                    <div className="rounded-xl bg-brand-50 p-3 text-sm">
                      <p className="font-semibold text-brand-900">
                        {selectedRolls.length} roll{selectedRolls.length === 1 ? '' : 's'} selected ·{' '}
                        {formatKg(selectedKg)}
                      </p>
                      <p className="text-brand-800">Rolls cost: {formatCurrency(rollsCost)}</p>
                    </div>
                  )}
                </div>
              )}

              {orderableProducts.length > 0 && (
                <div className="space-y-3">
                  <p className="text-sm font-semibold text-slate-800">Other products</p>
                  {cart.map((line, i) => {
                    const product = products.find((p) => p.id === line.finished_good_id)
                    return (
                      <div key={i} className="rounded-xl border border-slate-200 p-3">
                        <div className="grid grid-cols-1 gap-2 items-end sm:grid-cols-[2fr_1fr_auto]">
                          <Select
                            label={i === 0 ? 'Product' : undefined}
                            value={line.finished_good_id}
                            onChange={(e) => updateCartLine(i, { finished_good_id: e.target.value })}
                          >
                            <option value="">— Select a product —</option>
                            {orderableProducts.map((p) => (
                              <option key={p.id} value={p.id}>
                                {p.product_name} — {formatCurrency(p.unit_price || 0)} / {unitLabel(p)}
                                {p.customer_id ? ' (your branded product)' : ''}
                              </option>
                            ))}
                          </Select>
                          <Input
                            label={`Quantity${product ? ` (${unitLabel(product)})` : ''}`}
                            type="number"
                            step="0.01"
                            value={line.quantity}
                            onChange={(e) => updateCartLine(i, { quantity: e.target.value })}
                          />
                          <Button
                            type="button"
                            variant="secondary"
                            onClick={() => setCart(cart.filter((_, idx) => idx !== i))}
                            disabled={cart.length === 1}
                          >
                            ✕
                          </Button>
                        </div>
                      </div>
                    )
                  })}
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => setCart([...cart, { finished_good_id: '', quantity: '' }])}
                  >
                    + Add Another Product
                  </Button>
                </div>
              )}

              <div className="grid grid-cols-1 gap-4 border-t pt-4 sm:grid-cols-2">
                <Input
                  label="Delivery Date"
                  type="date"
                  value={deliveryDate}
                  onChange={(e) => setDeliveryDate(e.target.value)}
                />
                <Input label="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
              </div>

              <div className="flex items-center justify-between border-t pt-4">
                <p className="text-sm text-slate-600">
                  Total: <span className="font-bold text-slate-900">{formatCurrency(orderTotal)}</span>
                </p>
                <div className="flex gap-2">
                  {editingOrderId && <Button type="button" variant="secondary" onClick={()=>{
                    setEditingOrderId(null);setCart([{finished_good_id:'',quantity:''}]);setSelectedRollIds([])
                  }}>Stop Editing</Button>}
                  <Button type="submit" loading={submitting}>{editingOrderId ? 'Save Changes' : 'Place Order'}</Button>
                </div>
              </div>
            </form>
          )}
        </Card>
      )}

      {tab === 'my-orders' && (
        <Card title="My Orders">
          <ResponsiveTable
            headers={['Order #', 'Date', 'Items', 'Total', 'Balance', 'Status', 'Delivery', '']}
            isEmpty={orders.length === 0}
            emptyMessage="You haven't placed any orders yet"
          >
            {orders.map((o) => (
              <TableRow
                key={o.id}
                cells={[
                  o.order_number,
                  formatDate(o.created_at),
                  (o.order_items || []).map(describeItem).join(', ') || '—',
                  formatCurrency(o.total),
                  formatCurrency(o.balance_due),
                  <Badge variant={getOrderStatusBadge(o.status)}>{ORDER_STATUS_LABELS[o.status]}</Badge>,
                  <Badge variant={getDeliveryStatusBadge(o.delivery_status)}>
                    {DELIVERY_STATUS_LABELS[o.delivery_status]}
                  </Badge>,
                  <div className="flex gap-2 flex-wrap">
                    <Button variant="secondary" onClick={() => setSelectedOrder(o)}>View</Button>
                    {o.status==='pending' && <>
                      <Button variant="secondary" onClick={()=>startEditOrder(o)}>Edit</Button>
                      <Button variant="secondary" onClick={()=>cancelPendingOrder(o)}>Cancel</Button>
                    </>}
                  </div>,
                ]}
                mobileCard={
                  <div className="space-y-2 text-sm">
                    <div className="flex justify-between">
                      <span className="font-medium">{o.order_number}</span>
                      <Badge variant={getOrderStatusBadge(o.status)}>{ORDER_STATUS_LABELS[o.status]}</Badge>
                    </div>
                    <p className="text-xs text-slate-500">
                      {(o.order_items || []).map(describeItem).join(', ')}
                    </p>
                    <div className="flex items-center justify-between text-xs">
                      <span>{formatDate(o.created_at)}</span>
                      <Badge variant={getDeliveryStatusBadge(o.delivery_status)}>
                        {DELIVERY_STATUS_LABELS[o.delivery_status]}
                      </Badge>
                    </div>
                    <div className="flex justify-between text-xs">
                      <span>Balance: {formatCurrency(o.balance_due)}</span>
                      <span className="font-semibold">{formatCurrency(o.total)}</span>
                    </div>
                    <Button variant="secondary" className="w-full" onClick={() => setSelectedOrder(o)}>View Order</Button>
                    {o.status==='pending' && <div className="flex gap-2">
                      <Button variant="secondary" onClick={()=>startEditOrder(o)}>Edit</Button>
                      <Button variant="secondary" onClick={()=>cancelPendingOrder(o)}>Cancel</Button>
                    </div>}
                  </div>
                }
              />
            ))}
          </ResponsiveTable>
        </Card>
      )}

      {selectedOrder && (
        <OrderDetailModal
          order={selectedOrder}
          canPay
          onClose={() => setSelectedOrder(null)}
          onPaid={fetchData}
        />
      )}
    </div>
  )
}
