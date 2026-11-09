import { useCallback, useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { useAutoRefresh } from '@/hooks/useAutoRefresh'
import { useAuthStore } from '@/stores/authStore'
import { useToastStore } from '@/stores/toastStore'
import type { Customer, Order, Payment, FinishedGood } from '@/types/database'
import { formatCurrency, formatDate, ORDER_STATUS_LABELS, DELIVERY_STATUS_LABELS } from '@/lib/format'
import { Card, StatCard } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Badge, getOrderStatusBadge, getDeliveryStatusBadge } from '@/components/ui/Badge'
import { ResponsiveTable, TableRow } from '@/components/ui/Table'
import { LoadingSpinner } from '@/components/ui/LoadingSpinner'
import { PageTabs } from '@/components/ui/PageTabs'
import { CustomerFormModal } from './CustomerFormModal'
import { OrderFormModal } from './OrderFormModal'
import { PaymentModal } from './PaymentModal'
import { RefundModal } from './RefundModal'
import { OrderDetailModal } from '@/components/orders/OrderDetailModal'
import { verifyReturnedPayment } from '@/lib/paystack'

type Tab = 'orders' | 'customers' | 'payments'

export function SalesPage() {
  const [tab, setTab] = useState<Tab>('orders')
  const [customers, setCustomers] = useState<Customer[]>([])
  const [orders, setOrders] = useState<Order[]>([])
  const [payments, setPayments] = useState<Payment[]>([])
  const [finishedGoods, setFinishedGoods] = useState<FinishedGood[]>([])
  const [loading, setLoading] = useState(true)
  const [showCustomerForm, setShowCustomerForm] = useState(false)
  const [showOrderForm, setShowOrderForm] = useState(false)
  const [paymentOrder, setPaymentOrder] = useState<Order | null>(null)
  const [detailOrder, setDetailOrder] = useState<Order | null>(null)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [refundPayment,setRefundPayment]=useState<Payment | null>(null)
  const [refunds,setRefunds]=useState<Record<string,number>>({})
  const [pendingRefunds,setPendingRefunds]=useState<Record<string,number>>({})
  const [refundRequests,setRefundRequests]=useState<{reference:string;amount:number;status:string}[]>([])
  const [summary,setSummary]=useState({net_receipts:0,outstanding:0,order_count:0,pending_approvals:0})
  const isAdmin = useAuthStore(s=>s.hasRole('admin'))

  const canWrite = useAuthStore((s) => s.hasRole('admin', 'sales_staff'))
  const addToast = useToastStore((s) => s.addToast)

  const fetchData = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    const [custRes, ordRes, payRes, finRes, summaryRes,refundRes,requestsRes] = await Promise.all([
      supabase.from('customers').select('*').order('name'),
      supabase
        .from('orders')
        .select('*, customers(name, business_name), order_items(*, finished_goods(product_name))')
        .order('created_at', { ascending: false }).limit(100),
      supabase
        .from('payments')
        .select('*, orders(order_number, customers(name))')
        .order('created_at', { ascending: false })
        .limit(50),
      supabase.from('finished_goods').select('*').order('product_name').limit(500),
      supabase.rpc('sales_metrics'),
      supabase.from('payment_refunds').select('payment_id,amount').order('created_at',{ascending:false}).limit(500),
      supabase.from('paystack_refund_requests').select('reference,payment_id,amount,status')
        .order('created_at',{ascending:false}).limit(500),
    ])

    const failure=[custRes,ordRes,payRes,finRes,summaryRes,refundRes,requestsRes].find(r=>r.error)
    if(failure?.error){setFetchError(failure.error.message);setLoading(false);return}
    setFetchError(null)
    setCustomers(custRes.data || [])
    setOrders(ordRes.data || [])
    setPayments(payRes.data || [])
    setFinishedGoods(finRes.data || [])
    if(summaryRes.data)setSummary(summaryRes.data as typeof summary)
    const refundMap:Record<string,number>={}
    for(const r of refundRes.data||[])refundMap[r.payment_id]=(refundMap[r.payment_id]||0)+Number(r.amount)
    setRefunds(refundMap)
    const pendingMap:Record<string,number>={}
    for(const r of requestsRes.data||[])if(['pending','processing','needs-attention'].includes(r.status))
      pendingMap[r.payment_id]=(pendingMap[r.payment_id]||0)+Number(r.amount)
    setPendingRefunds(pendingMap)
    setRefundRequests((requestsRes.data||[]).map(r=>({reference:r.reference,amount:Number(r.amount),status:r.status})))
    if (!silent) setLoading(false)
  },[])

  useEffect(() => {
    void fetchData()
  }, [fetchData])

  useAutoRefresh(() => fetchData(true), 60000)
  useEffect(() => {
    verifyReturnedPayment().then(verified=>{if(verified){addToast('Payment verified by Paystack');fetchData()}})
      .catch(err=>addToast(err instanceof Error?err.message:'Payment verification failed','error'))
  }, [addToast,fetchData])

  const totalRevenue=summary.net_receipts
  const outstanding=summary.outstanding
  const pendingApprovals=summary.pending_approvals

  const changeOrder = async (orderId: string, action: 'confirm'|'dispatch'|'deliver'|'cancel') => {
    if (action==='cancel' && !window.confirm('Cancel this order? Stock will be restored if already confirmed.')) return
    const {error}=await supabase.rpc('change_order_state',{p_order:orderId,p_action:action})
    if(error) addToast(error.message,'error')
    else {addToast(`Order action: ${action}`);fetchData()}
  }

  const reconcileRefund=async(reference:string)=>{
    const {data,error}=await supabase.functions.invoke('paystack-refund',{body:{action:'reconcile',reference}})
    if(error||data?.error){addToast(data?.error||error?.message||'Refund not reconciled','error');return}
    addToast(`Provider refund status: ${data.status}`)
    void fetchData()
  }

  const updateApprovalStatus = async (customerId: string, approval_status: 'approved' | 'rejected') => {
    const { error } = await supabase
      .from('customers')
      .update({ approval_status })
      .eq('id', customerId)

    if (error) {
      addToast(error.message, 'error')
    } else {
      addToast(`Company ${approval_status}`)
      fetchData()
    }
  }

  const tabs = [
    { id: 'orders' as const, label: 'Orders' },
    { id: 'customers' as const, label: 'Customers' },
    { id: 'payments' as const, label: 'Payments' },
  ]

  if (loading) return <LoadingSpinner className="py-20" />
  if (fetchError) return <Card title="Sales unavailable"><p role="alert" className="text-red-700">{fetchError}</p>
    <Button onClick={()=>fetchData()}>Retry</Button></Card>

  return (
    <div className="page-shell space-y-6">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="Net Receipts (all time)" value={formatCurrency(totalRevenue)} />
        <StatCard label="Outstanding Balance" value={formatCurrency(outstanding)} alert={outstanding > 0} />
        <StatCard label="Total Orders" value={summary.order_count} />
        <StatCard label="Pending Approvals" value={pendingApprovals} alert={pendingApprovals > 0} />
      </div>

      <PageTabs
        tabs={tabs}
        active={tab}
        onChange={(id) => setTab(id as Tab)}
        action={
          canWrite && tab === 'customers' ? (
            <Button variant="secondary" onClick={() => setShowCustomerForm(true)}>
              + Add Customer
            </Button>
          ) : canWrite && tab === 'orders' ? (
            <Button variant="secondary" onClick={() => setShowOrderForm(true)}>
              + Create Order
            </Button>
          ) : undefined
        }
      />

      {tab === 'orders' && (
        <Card title="Orders (100 most recent)">
          <ResponsiveTable
            headers={['Order #', 'Customer', 'Total', 'Paid', 'Balance', 'Status', 'Delivery', 'Actions']}
            isEmpty={orders.length === 0}
          >
            {orders.map((o) => (
              <TableRow
                key={o.id}
                cells={[
                  o.order_number,
                  (o.customers as Customer)?.name || '—',
                  formatCurrency(o.total),
                  formatCurrency(o.amount_paid),
                  formatCurrency(o.balance_due),
                  <Badge variant={getOrderStatusBadge(o.status)}>
                    {ORDER_STATUS_LABELS[o.status]}
                  </Badge>,
                  <Badge variant={getDeliveryStatusBadge(o.delivery_status)}>
                    {DELIVERY_STATUS_LABELS[o.delivery_status]}
                  </Badge>,
                  <div className="flex gap-2 flex-wrap">
                    <Button variant="secondary" onClick={() => setDetailOrder(o)}>
                      View
                    </Button>
                    {canWrite && o.status === 'pending' && (
                      <Button variant="secondary" onClick={() => changeOrder(o.id, 'confirm')}>Confirm</Button>
                    )}
                    {canWrite && ['pending','confirmed','in_production'].includes(o.status) && o.amount_paid===0 && (
                      <Button variant="secondary" onClick={()=>changeOrder(o.id,'cancel')}>Cancel</Button>
                    )}
                    {canWrite && o.balance_due > 0 && !['pending','cancelled'].includes(o.status) && (
                      <Button variant="secondary" onClick={() => setPaymentOrder(o)}>
                        Pay
                      </Button>
                    )}
                    {canWrite && ['confirmed','in_production','paid'].includes(o.status) && o.delivery_status === 'pending' && (
                      <Button variant="secondary" onClick={() => changeOrder(o.id, 'dispatch')}>
                        Dispatch
                      </Button>
                    )}
                    {canWrite && o.status==='dispatched' && o.delivery_status === 'dispatched' && (
                      <Button variant="secondary" onClick={() => changeOrder(o.id, 'deliver')}>
                        Mark Delivered
                      </Button>
                    )}
                  </div>,
                ]}
                mobileCard={
                  <div className="space-y-2 text-sm">
                    <div className="flex justify-between">
                      <span className="font-medium">{o.order_number}</span>
                      <Badge variant={getOrderStatusBadge(o.status)}>
                        {ORDER_STATUS_LABELS[o.status]}
                      </Badge>
                    </div>
                    <p>{(o.customers as Customer)?.name}</p>
                    <div className="flex items-center justify-between text-xs">
                      <span>Total: {formatCurrency(o.total)}</span>
                      <Badge variant={getDeliveryStatusBadge(o.delivery_status)}>
                        {DELIVERY_STATUS_LABELS[o.delivery_status]}
                      </Badge>
                    </div>
                    <div className="flex justify-between text-xs">
                      <span>Due: {formatCurrency(o.balance_due)}</span>
                    </div>
                    {canWrite && (
                      <div className="flex gap-2 flex-wrap">
                        {o.delivery_status === 'pending' && (
                          <Button variant="secondary" onClick={() => changeOrder(o.id, 'dispatch')}>
                            Dispatch
                          </Button>
                        )}
                        {o.delivery_status === 'dispatched' && (
                          <Button variant="secondary" onClick={() => changeOrder(o.id, 'deliver')}>
                            Mark Delivered
                          </Button>
                        )}
                      </div>
                    )}
                    <Button variant="secondary" className="w-full" onClick={() => setDetailOrder(o)}>
                      View Order
                    </Button>
                  </div>
                }
              />
            ))}
          </ResponsiveTable>
        </Card>
      )}

      {tab === 'customers' && (
        <Card title="Customers">
          <ResponsiveTable
            headers={['Name', 'Business', 'Phone', 'Email', 'Credit Terms', 'Account', 'Actions']}
            isEmpty={customers.length === 0}
          >
            {customers.map((c) => (
              <TableRow
                key={c.id}
                cells={[
                  c.name,
                  c.business_name || '—',
                  c.contact_phone || '—',
                  c.contact_email || '—',
                  c.credit_terms_days ? `${c.credit_terms_days} days` : 'Cash',
                  c.owner_profile_id ? (
                    <Badge
                      variant={
                        c.approval_status === 'approved'
                          ? 'success'
                          : c.approval_status === 'rejected'
                          ? 'danger'
                          : 'warning'
                      }
                    >
                      Portal · {c.approval_status}
                    </Badge>
                  ) : (
                    <Badge variant="default">Manual</Badge>
                  ),
                  canWrite && c.owner_profile_id && c.approval_status === 'pending' ? (
                    <div className="flex gap-2 flex-wrap">
                      <Button variant="secondary" onClick={() => updateApprovalStatus(c.id, 'approved')}>
                        Approve
                      </Button>
                      <Button variant="danger" onClick={() => updateApprovalStatus(c.id, 'rejected')}>
                        Reject
                      </Button>
                    </div>
                  ) : null,
                ]}
                mobileCard={
                  <div className="space-y-1 text-sm">
                    <div className="flex items-center justify-between">
                      <p className="font-medium">{c.name}</p>
                      {c.owner_profile_id && (
                        <Badge
                          variant={
                            c.approval_status === 'approved'
                              ? 'success'
                              : c.approval_status === 'rejected'
                              ? 'danger'
                              : 'warning'
                          }
                        >
                          {c.approval_status}
                        </Badge>
                      )}
                    </div>
                    {c.business_name && <p className="text-xs text-slate-500">{c.business_name}</p>}
                    <p className="text-xs">{c.contact_phone}</p>
                    {canWrite && c.owner_profile_id && c.approval_status === 'pending' && (
                      <div className="flex gap-2 pt-1">
                        <Button variant="secondary" onClick={() => updateApprovalStatus(c.id, 'approved')}>
                          Approve
                        </Button>
                        <Button variant="danger" onClick={() => updateApprovalStatus(c.id, 'rejected')}>
                          Reject
                        </Button>
                      </div>
                    )}
                  </div>
                }
              />
            ))}
          </ResponsiveTable>
        </Card>
      )}

      {tab === 'payments' && (
        <Card title="Payment History (50 most recent)">
          <ResponsiveTable
            headers={['Date', 'Order', 'Customer', 'Amount', 'Method', 'Refunds']}
            isEmpty={payments.length === 0}
          >
            {payments.map((p) => {
              const order = p.orders as (Order & { customers?: Customer }) | undefined
              return (
                <TableRow
                  key={p.id}
                  cells={[
                    formatDate(p.created_at),
                    order?.order_number || '—',
                    order?.customers?.name || '—',
                    formatCurrency(p.amount),
                    p.payment_method.replace('_', ' '),
                    isAdmin ? <Button variant="secondary" disabled={p.amount-(refunds[p.id]||0)-(pendingRefunds[p.id]||0)<=0}
                      onClick={()=>setRefundPayment(p)}>Refund</Button> : '—',
                  ]}
                  mobileCard={
                    <div className="flex justify-between text-sm">
                      <span>{formatDate(p.created_at)}</span>
                      <span className="font-medium">{formatCurrency(p.amount)}</span>
                      {isAdmin && <Button variant="secondary" disabled={p.amount-(refunds[p.id]||0)-(pendingRefunds[p.id]||0)<=0}
                        onClick={()=>setRefundPayment(p)}>Refund</Button>}
                    </div>
                  }
                />
              )
            })}
          </ResponsiveTable>
          {refundRequests.length>0 && <div className="mt-5 border-t pt-3 text-sm">
            <h3 className="font-semibold mb-2">Recent Paystack refund requests</h3>
            {refundRequests.slice(0,8).map(r=><p key={r.reference} className="py-1">
              {formatCurrency(r.amount)} · {r.status} · <span className="text-slate-500">{r.reference}</span>
              {isAdmin && !['processed','failed'].includes(r.status) && <Button variant="secondary"
                onClick={()=>reconcileRefund(r.reference)}>Check provider</Button>}
            </p>)}
          </div>}
        </Card>
      )}

      {refundPayment && <RefundModal payment={refundPayment} refunded={refunds[refundPayment.id]||0}
        pending={pendingRefunds[refundPayment.id]||0} onClose={()=>setRefundPayment(null)}
        onSuccess={()=>{setRefundPayment(null);fetchData()}}/>}

      {showCustomerForm && (
        <CustomerFormModal
          onClose={() => setShowCustomerForm(false)}
          onSuccess={() => {
            setShowCustomerForm(false)
            fetchData()
            addToast('Customer added')
          }}
        />
      )}

      {showOrderForm && (
        <OrderFormModal
          customers={customers}
          finishedGoods={finishedGoods}
          onClose={() => setShowOrderForm(false)}
          onSuccess={() => {
            setShowOrderForm(false)
            fetchData()
            addToast('Order created')
          }}
        />
      )}

      {paymentOrder && (
        <PaymentModal
          order={paymentOrder}
          onClose={() => setPaymentOrder(null)}
          onSuccess={() => {
            setPaymentOrder(null)
            fetchData()
            addToast('Payment recorded')
          }}
        />
      )}

      {detailOrder && (
        <OrderDetailModal
          order={detailOrder}
          onClose={() => setDetailOrder(null)}
        />
      )}
    </div>
  )
}
