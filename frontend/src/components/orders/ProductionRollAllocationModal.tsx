import { useEffect,useState } from 'react'
import { supabase } from '@/lib/supabase'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { useToastStore } from '@/stores/toastStore'
import { formatKg } from '@/lib/format'
import type { Order,ProductRoll } from '@/types/database'

/** Explicit factory dispatch hand-off for made-to-order products. */
export function ProductionRollAllocationModal({order,onClose,onAllocated}:{
  order:Order;onClose:()=>void;onAllocated:()=>void
}) {
  const toast=useToastStore(s=>s.addToast)
  const [rolls,setRolls]=useState<ProductRoll[]>([])
  const [allocated,setAllocated]=useState<ProductRoll[]>([])
  const [selected,setSelected]=useState<string[]>([])
  const [loading,setLoading]=useState(true)
  const [saving,setSaving]=useState(false)
  const line=order.order_items?.[0]
  const target=Number(order.production_target_kg||0)
  const count=Number(order.production_rolls_requested||0)
  useEffect(()=>{
    let mounted=true
    const load=async()=>{
      if(!line){setLoading(false);return}
      const [stock,existing]=await Promise.all([
        supabase.from('product_rolls').select('*').eq('finished_good_id',line.finished_good_id).eq('status','available').order('roll_no').limit(1000),
        supabase.from('product_rolls').select('*').eq('order_item_id',line.id).order('roll_no'),
      ])
      if(!mounted)return
      if(stock.error||existing.error)toast(stock.error?.message||existing.error?.message||'Unable to load rolls','error')
      setRolls(stock.data||[]);setAllocated(existing.data||[]);setLoading(false)
    }
    void load()
    return()=>{mounted=false}
  },[line,toast])
  const chosen=rolls.filter(r=>selected.includes(r.id))
  const weight=chosen.reduce((n,r)=>n+Number(r.weight_kg),0)
  const ready=selected.length===count && weight>=target
  const submit=async()=>{
    if(!ready||saving)return
    setSaving(true)
    const {error}=await supabase.rpc('allocate_production_order_rolls',{p_order:order.id,p_roll_ids:selected})
    setSaving(false)
    if(error){toast(error.message,'error');return}
    toast('Physical rolls allocated and stock deducted once. Order is ready for dispatch.')
    onAllocated();onClose()
  }
  return <Modal open size="lg" title={`Allocate produced rolls — ${order.order_number}`} onClose={onClose}>
    <div className="space-y-4">
      <p className="text-sm text-slate-600">Choose exactly {count} produced rolls for this customer's order. Their measured total must be at least {formatKg(target)}. Inventory is deducted only when you allocate.</p>
      {loading ? <p className="text-sm">Loading physical roll inventory…</p>
        : allocated.length>0 ? <p className="rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800">{allocated.length} physical rolls are already allocated. Do not allocate twice.</p>
        : <>
          <div className="max-h-72 overflow-y-auto rounded-lg border border-slate-200 p-2 grid grid-cols-2 md:grid-cols-3 gap-2">
            {rolls.map(r=>{
              const active=selected.includes(r.id)
              return <button type="button" key={r.id} aria-pressed={active}
                className={`rounded-lg border p-2 text-left text-sm ${active?'border-brand-700 bg-brand-50':'border-slate-200'}`}
                onClick={()=>setSelected(prev=>active?prev.filter(x=>x!==r.id):prev.length<count?[...prev,r.id]:prev)}>
                Roll #{r.roll_no} · {formatKg(r.weight_kg)}
              </button>
            })}
            {rolls.length===0&&<p className="col-span-full p-3 text-sm text-slate-600">No produced rolls are available yet.</p>}
          </div>
          <p className="text-sm font-medium">Selected: {selected.length}/{count} rolls · {formatKg(weight)} / {formatKg(target)} required</p>
          {selected.length===count&&weight<target&&<p role="alert" className="text-sm text-amber-800">Selected rolls weigh less than the ordered amount. Log additional production or contact sales to resolve the shortfall.</p>}
        </>}
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>Close</Button>
        {allocated.length===0&&<Button disabled={!ready||loading} loading={saving} onClick={submit}>Allocate & Deduct Stock</Button>}
      </div>
    </div>
  </Modal>
}
