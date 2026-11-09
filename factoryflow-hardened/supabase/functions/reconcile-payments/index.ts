import { admin, response, verifyAndSettle } from '../_shared/paystack.ts'
import { reconcilePaystackRefund } from '../_shared/refunds.ts'

// Called by a trusted scheduler every ~15 minutes with a 32+-char bearer secret.
// Never expose this token to the browser or client environment.
Deno.serve(async(req)=>{
  if(req.method!=='POST')return response({error:'Method not allowed'},405)
  const secret=Deno.env.get('PAYMENT_RECONCILE_TOKEN') || ''
  const supplied=(req.headers.get('authorization')||'').replace(/^Bearer /,'')
  // Fixed-shape compare; secret is independent of Supabase user sessions.
  if(secret.length<32||supplied.length!==secret.length)return response({error:'Unauthorized'},401)
  let diff=0
  for(let i=0;i<secret.length;i++)diff|=secret.charCodeAt(i)^supplied.charCodeAt(i)
  if(diff!==0)return response({error:'Unauthorized'},401)
  const results={attempts_checked:0,attempts_settled:0,refunds_checked:0,refunds_processed:0,errors:0}
  const cutoff=new Date(Date.now()-5*60*1000).toISOString()
  const {data:attempts,error:paymentError}=await admin.from('payment_attempts')
    .select('reference').eq('status','pending').lt('created_at',cutoff)
    .order('last_checked_at',{ascending:true,nullsFirst:true}).limit(40)
  if(paymentError)return response({error:'Cannot list pending payments'},503)
  for(const attempt of attempts||[]){
    results.attempts_checked++
    try{const r=await verifyAndSettle(attempt.reference);if(r.settled)results.attempts_settled++}
    catch{results.errors++ /* Unknown/failed transactions are never recorded as paid. */}
    await admin.from('payment_attempts').update({last_checked_at:new Date().toISOString()})
      .eq('reference',attempt.reference)
  }
  const {data:refunds,error:refundError}=await admin.from('paystack_refund_requests')
    .select('reference').in('status',['pending','processing','needs-attention'])
    .lt('created_at',cutoff).order('last_checked_at',{ascending:true,nullsFirst:true}).limit(40)
  if(refundError)return response({error:'Cannot list pending refunds'},503)
  for(const r of refunds||[]){
    results.refunds_checked++
    try{const result=await reconcilePaystackRefund(r.reference);if(result.settled)results.refunds_processed++}
    catch{results.errors++}
    await admin.from('paystack_refund_requests').update({last_checked_at:new Date().toISOString()})
      .eq('reference',r.reference)
  }
  return response(results)
})
