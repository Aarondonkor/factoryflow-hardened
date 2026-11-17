import { useState } from 'react'
import { supabase } from '@/lib/supabase'
import { startVerifiedCheckout } from '@/lib/paystack'
import { formatCurrency, formatKg, toInputDate } from '@/lib/format'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { useToastStore } from '@/stores/toastStore'

// Returned by the customer_available_stock() RPC. Only the signed-in company's
// branded inventory is exposed; counts and kg are aggregated in PostgreSQL.
export interface CustomerStock {
  finished_good_id: string
  product_name: string
  stage: 'semi_finished' | 'finished'
  unit: 'kg' | 'rolls' | 'bundle'
  available_quantity: number
  available_roll_count: number
  available_weight_kg: number
  unit_price: number | null
  customer_orderable: boolean
  spec_thickness: number | null
  spec_thickness_min: number | null
  spec_thickness_max: number | null
}

export function CustomerStockPage({ stock, approved, onRefresh, onViewOrders }: {
  stock: CustomerStock[]
  approved: boolean
  onRefresh: () => void
  onViewOrders: () => void
}) {
  const toast = useToastStore(s=>s.addToast)
  const [productId,setProductId]=useState<string|null>(null)
  const [rolls,setRolls]=useState('5')
  const [micron,setMicron]=useState('')
  const [deliveryDate,setDeliveryDate]=useState(toInputDate(new Date(Date.now()+7*86400000)))
  const [notes,setNotes]=useState('')
  const [submitting,setSubmitting]=useState(false)

  const selected=stock.find(p=>p.finished_good_id===productId)
  const count=Number(rolls)
  const validCount=Number.isInteger(count) && count>=5 && count<=1000
  const targetKg=validCount ? count*20 : 0
  const micronValue=Number(micron)
  const validMicron=micron.trim()!=='' && Number.isFinite(micronValue) && micronValue>0
    && (selected?.spec_thickness_min==null || micronValue>=selected.spec_thickness_min)
    && (selected?.spec_thickness_max==null || micronValue<=selected.spec_thickness_max)
  const total=selected?.unit_price && validCount ? targetKg*Number(selected.unit_price) : 0
  const deposit=validCount && count>5 ? Math.ceil(Math.round(total*100)*0.5)/100 : 0

  const submit=async(event:React.FormEvent)=>{
    event.preventDefault()
    if(!selected||!validCount||!validMicron||!approved||submitting)return
    setSubmitting(true)
    try {
      const {data:id,error}=await supabase.rpc('customer_request_production_order',{
        p_finished_good:selected.finished_good_id,
        p_roll_count:count,
        p_delivery_date:deliveryDate,
        p_notes:notes||null,
        p_micron:micronValue,
      })
      if(error||!id)throw new Error(error?.message||'Could not create production order')
      setProductId(null)
      setRolls('5')
      setMicron('')
      setNotes('')
      onRefresh()
      if(deposit>0){
        toast('Production request saved. Complete the 50% deposit to proceed.')
        try { await startVerifiedCheckout(id) }
        catch(err){
          toast(`Order saved; deposit still due. Pay from My Orders. ${err instanceof Error?err.message:''}`,'error')
          onViewOrders()
        }
      } else {
        toast('100 kg (5-roll) production order submitted without payment')
        onViewOrders()
      }
    } catch(err){toast(err instanceof Error?err.message:'Request failed','error')}
    finally{setSubmitting(false)}
  }

  return <div className="space-y-5">
    <Card title="My Available Stock" subtitle="Only products branded for your company appear here. Available rolls and weights are measured from the physical roll register.">
      {stock.length===0 ? <p className="text-sm text-slate-600">
        No branded products have been registered for your company. Please ask Purifa Ventures to add your product specification and price.
      </p> : <div className="space-y-3">
        {stock.map(item=>{
          const zero=item.unit==='rolls' ? Number(item.available_roll_count)===0 : Number(item.available_quantity)===0
          const canRequest=approved && zero && item.unit==='rolls' && item.customer_orderable && Number(item.unit_price)>0
          return <div key={item.finished_good_id} className="rounded-xl border border-slate-200 p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="font-semibold text-slate-900">{item.product_name}</p>
                <p className="text-xs text-slate-500 capitalize">{item.stage.replace('_',' ')} · Your branded product</p>
                {item.unit==='rolls' ? <p className="mt-1 text-sm text-slate-700">
                  <strong>{item.available_roll_count} available rolls</strong> · {formatKg(Number(item.available_weight_kg))}
                </p> : <p className="mt-1 text-sm text-slate-700"><strong>{item.available_quantity} {item.unit}</strong> available</p>}
                {item.unit_price != null && <p className="mt-1 text-xs text-slate-500">Listed price: {formatCurrency(item.unit_price)} / {item.unit==='rolls'?'kg':item.unit}</p>}
              </div>
              {canRequest ? <Button type="button" variant="secondary" onClick={()=>{setProductId(item.finished_good_id);setRolls('5');setMicron(String(item.spec_thickness??item.spec_thickness_min??''))}}>
                Request Production
              </Button> : zero ? <span className="text-sm font-semibold text-amber-700">Out of stock</span>
                : <span className="text-sm font-semibold text-emerald-700">In stock</span>}
            </div>
          </div>
        })}
      </div>}
      <p className="mt-4 text-xs text-slate-500">
        To buy physical rolls already in stock, use Place Order. Production requests are only available when your branded roll has no available stock.
      </p>
    </Card>
    {selected && <Card title={`Request Production — ${selected.product_name}`}>
      <form onSubmit={submit} className="space-y-4">
        <p className="text-sm text-slate-600">Minimum: <strong>5 rolls (100 kg)</strong>. Each requested roll is priced at a nominal 20 kg. The factory records actual roll weights during production.</p>
        <Input label="Number of rolls" type="number" min="5" max="1000" step="1" required value={rolls}
          onChange={e=>setRolls(e.target.value)}/>
        <Input label="Required thickness (microns)" type="number" step="0.01" min={selected.spec_thickness_min??'0.01'}
          max={selected.spec_thickness_max??undefined} required value={micron} onChange={e=>setMicron(e.target.value)}/>
        <Input label="Preferred delivery date" type="date" required value={deliveryDate}
          onChange={e=>setDeliveryDate(e.target.value)}/>
        <Input label="Special production instructions (optional)" value={notes} onChange={e=>setNotes(e.target.value)}/>
        <div className="rounded-xl bg-slate-50 p-4 text-sm space-y-1" aria-live="polite">
          <p>Requested weight: <strong>{validCount?formatKg(targetKg):'Choose 5 or more whole rolls'}</strong></p>
          <p>Total cost: <strong>{formatCurrency(total)}</strong></p>
          {validCount && count===5 ? <p className="font-medium text-emerald-700">No upfront payment. Submit for factory review.</p>
            : <p className="font-medium text-amber-800">Pay at least 50% before this order can be confirmed: {formatCurrency(deposit)}</p>}
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="secondary" onClick={()=>setProductId(null)}>Cancel</Button>
          <Button type="submit" disabled={!validCount||!validMicron||total<=0} loading={submitting}>
            {deposit>0 ? `Continue to 50% Payment (${formatCurrency(deposit)})` : 'Submit Order — No Payment'}
          </Button>
        </div>
      </form>
    </Card>}
  </div>
}
