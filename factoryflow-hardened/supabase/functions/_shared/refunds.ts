import { admin, paystack } from './paystack.ts'

export async function reconcilePaystackRefund(reference:string) {
  if(!/^[A-Za-z0-9_-]{8,64}$/.test(reference)) throw new Error('Invalid refund reference')
  const {data:req,error:reqError}=await admin.from('paystack_refund_requests')
    .select('reference,payment_id,amount,currency,status,payments(paystack_reference)')
    .eq('reference',reference).single()
  if(reqError||!req)throw new Error('Refund reference not found')
  const result=await paystack(`/refund?reference=${encodeURIComponent(reference)}`)
  const list=Array.isArray(result)?result:(Array.isArray(result?.data)?result.data:[])
  const found=list.find((r:{reference?:string})=>r.reference===reference)
  if(!found)throw new Error('Refund not yet confirmed by Paystack')
  if(found.currency!=='GHS'||Number(found.amount)!==Math.round(Number(req.amount)*100))
    throw new Error('Paystack refund currency or amount mismatch')
  const payment=Array.isArray(req.payments)?req.payments[0]:req.payments
  if(found.transaction_reference && found.transaction_reference!==payment?.paystack_reference)
    throw new Error('Refund belongs to another transaction')
  const allowed=['pending','processing','needs-attention','failed','processed']
  if(!allowed.includes(found.status))throw new Error('Unrecognized provider refund state')
  const {data:settled,error}=await admin.rpc('complete_paystack_refund',{
    p_reference:reference,p_status:found.status,p_provider_id:String(found.id||''),
  })
  if(error)throw new Error(error.message)
  return {status:found.status,settled:settled===true}
}
