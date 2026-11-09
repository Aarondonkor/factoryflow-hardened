import { useState } from 'react'
import { supabase } from '@/lib/supabase'
import { useToastStore } from '@/stores/toastStore'
import type { Payment } from '@/types/database'
import { formatCurrency } from '@/lib/format'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'

interface Props { payment:Payment; refunded:number; pending:number; onClose:()=>void; onSuccess:()=>void }
export function RefundModal({payment,refunded,pending,onClose,onSuccess}:Props) {
  const [amount,setAmount]=useState(String(Math.max(0,payment.amount-refunded-pending).toFixed(2)))
  const [reason,setReason]=useState('')
  const [loading,setLoading]=useState(false)
  const toast=useToastStore(s=>s.addToast)
  const max=payment.amount-refunded-pending
  const handle=async(e:React.FormEvent)=>{
    e.preventDefault()
    const amt=Number(amount)
    if(!Number.isFinite(amt)||amt<=0||Math.round(amt*100)!==amt*100||amt>max||reason.trim().length<5){
      toast('Enter a valid refund amount and a reason of at least five characters','error');return
    }
    if(!window.confirm(`Issue a ${formatCurrency(amt)} ${payment.payment_method==='paystack'?'Paystack refund request':'offline refund'}?`))return
    setLoading(true)
    try {
      if(payment.payment_method==='paystack'){
        const {data,error}=await supabase.functions.invoke('paystack-refund',{
          body:{action:'create',payment_id:payment.id,amount:amt,reason:reason.trim()},
        })
        if(error)throw error
        if(data?.error)throw new Error(data.error)
        toast('Refund initiated. Credit will update only after Paystack confirms processing.')
      }else{
        const {error}=await supabase.rpc('refund_offline_payment',{
          p_payment:payment.id,p_amount:amt,p_reason:reason.trim(),
        })
        if(error)throw error
        toast('Offline refund recorded; verify that the customer received the funds.')
      }
      onSuccess()
    }catch(err){toast(err instanceof Error?err.message:'Refund failed','error')}
    finally{setLoading(false)}
  }
  return <Modal open title="Refund payment" onClose={onClose}>
    <form onSubmit={handle} className="space-y-4">
      <p className="text-sm text-slate-700">Payment: {formatCurrency(payment.amount)} · Already refunded: {formatCurrency(refunded)} · Pending refund: {formatCurrency(pending)}. Maximum available: <strong>{formatCurrency(max)}</strong></p>
      <Input label="Refund amount (GHS)" type="number" min="0.01" max={max.toFixed(2)} step="0.01" value={amount} onChange={e=>setAmount(e.target.value)} required/>
      <Input label="Refund reason (required)" value={reason} onChange={e=>setReason(e.target.value)} required/>
      {payment.payment_method==='paystack' && <p className="text-xs text-slate-500">Requesting a refund does not mean it has been paid. The order ledger is updated only after Paystack reports a processed refund.</p>}
      <div className="flex justify-end gap-3"><Button variant="secondary" type="button" onClick={onClose}>Cancel</Button><Button type="submit" loading={loading}>Submit refund</Button></div>
    </form>
  </Modal>
}
