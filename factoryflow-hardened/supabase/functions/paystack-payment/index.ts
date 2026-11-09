import { admin, SITE_URL, cors, paystack, response, safeError, userFromRequest, verifyAndSettle } from '../_shared/paystack.ts'

Deno.serve(async (req) => {
  const headers = cors(req)
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers })
  if (req.method !== 'POST') return response({ error: 'Method not allowed' }, 405, headers)
  try {
    const { user, role } = await userFromRequest(req)
    const body = await req.json()
    if (body.action === 'verify') {
      const reference = String(body.reference || '')
      const { data: attempt } = await admin.from('payment_attempts').select('order_id').eq('reference', reference).single()
      if (!attempt) return response({ error: 'Unknown reference' }, 404, headers)
      const { data: order } = await admin.from('orders').select('customer_id, customers(owner_profile_id)').eq('id',attempt.order_id).single()
      const company = Array.isArray(order?.customers) ? order.customers[0] : order?.customers
      if (!['admin','sales_staff'].includes(role) && (role !== 'customer' || company?.owner_profile_id !== user.id))
        return response({ error: 'Forbidden' }, 403, headers)
      const result = await verifyAndSettle(reference)
      return response({ ok: true, ...result }, 200, headers)
    }
    if (body.action !== 'initialize') return response({ error: 'Unsupported action' }, 400, headers)
    const orderId = String(body.order_id || '')
    const { data: order, error } = await admin.from('orders')
      .select('id,customer_id,order_number,status,balance_due,customers(owner_profile_id,contact_email)')
      .eq('id',orderId).single()
    if (error || !order) return response({ error: 'Order not found' }, 404, headers)
    const company = Array.isArray(order.customers) ? order.customers[0] : order.customers
    if (!['admin','sales_staff'].includes(role) && (role!=='customer' || company?.owner_profile_id!==user.id))
      return response({ error: 'Forbidden' }, 403, headers)
    if (['pending','cancelled'].includes(order.status) || Number(order.balance_due)<=0)
      return response({ error: 'Order must be confirmed and have an outstanding balance' }, 409, headers)
    const requested = Number(body.amount)
    const amount = role==='customer' ? Number(order.balance_due) : requested
    if (!Number.isFinite(amount) || amount<=0 || amount>Number(order.balance_due) || Math.round(amount*100)!==amount*100)
      return response({ error: 'Invalid payment amount' }, 400, headers)
    const email = role==='customer' ? user.email : (company?.contact_email || user.email)
    if (!email) return response({ error: 'Payer email is required' }, 400, headers)
    const reference = `FF-${crypto.randomUUID()}`
    const { error: insertError } = await admin.from('payment_attempts').insert({
      order_id: order.id,amount,currency:'GHS',reference,initiated_by:user.id,
    })
    if (insertError) throw new Error('Could not register payment attempt')
    const callback = `${SITE_URL.replace(/\/$/,'')}${role==='customer'?'/customer':'/sales'}`
    const tx = await paystack('/transaction/initialize', {
      method:'POST', body:JSON.stringify({ email,amount:String(Math.round(amount*100)),currency:'GHS',reference,
        callback_url:callback,metadata:JSON.stringify({order_id:order.id}) }),
    })
    if (!tx.authorization_url || tx.reference!==reference || !String(tx.authorization_url).startsWith('https://checkout.paystack.com/'))
      throw new Error('Unexpected payment checkout response')
    return response({ authorization_url:tx.authorization_url,reference },200,headers)
  } catch(e) {
    return response({error:safeError(e)},400,headers)
  }
})
