import { admin, cors, paystack, response, safeError, userFromRequest } from '../_shared/paystack.ts'
import { reconcilePaystackRefund } from '../_shared/refunds.ts'

Deno.serve(async req=>{
  const headers=cors(req)
  if(req.method==='OPTIONS')return new Response(null,{status:204,headers})
  if(req.method!=='POST')return response({error:'Method not allowed'},405,headers)
  try {
    const {user,role}=await userFromRequest(req)
    if(role!=='admin')return response({error:'Administrator required'},403,headers)
    const body=await req.json()
    if(body.action==='reconcile') {
      return response(await reconcilePaystackRefund(String(body.reference||'')),200,headers)
    }
    if(body.action!=='create')return response({error:'Unknown refund action'},400,headers)
    const amount=Number(body.amount)
    const reason=String(body.reason||'').trim()
    if(!Number.isFinite(amount)||amount<=0||Math.round(amount*100)!==amount*100||reason.length<5||reason.length>500)
      return response({error:'Valid GHS amount and reason are required'},400,headers)
    const paymentId=String(body.payment_id||'')
    const {data:payment,error:paymentError}=await admin.from('payments').select('id,paystack_reference,payment_method')
      .eq('id',paymentId).single()
    if(paymentError||!payment||payment.payment_method!=='paystack'||!payment.paystack_reference)
      return response({error:'Only verified Paystack receipts are eligible'},409,headers)
    const reference=`RF_${crypto.randomUUID().replace(/-/g,'')}`
    const {error:reservationError}=await admin.rpc('reserve_paystack_refund',{
      p_payment:paymentId,p_amount:amount,p_reason:reason,p_reference:reference,p_user:user.id,
    })
    if(reservationError)throw new Error(reservationError.message)
    // If provider times out, the refund stays pending for reconciliation. Do not
    // retry with a new reference until Paystack's status is investigated.
    const initiated=await paystack('/refund',{
      method:'POST',body:JSON.stringify({
        transaction:payment.paystack_reference,amount:Math.round(amount*100),currency:'GHS',
        reference,merchant_note:reason,customer_note:'Refund initiated by FactoryFlow',
      }),
    })
    if(initiated.reference!==reference)throw new Error('Unexpected provider refund reference; investigate manually')
    // A successful initiation is NOT a refund completion. Await processed status.
    return response({reference,status:initiated.status||'pending',message:'Refund requested; awaiting provider processing'},200,headers)
  } catch(error){return response({error:safeError(error)},400,headers)}
})
