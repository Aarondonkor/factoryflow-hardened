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
      .select('id,customer_id,order_number,status,balance_due,amount_paid,deposit_required,fulfillment_mode,customers(owner_profile_id,contact_email)')
      .eq('id',orderId).single()
    if (error || !order) return response({ error: 'Order not found' }, 404, headers)
    const company = Array.isArray(order.customers) ? order.customers[0] : order.customers
    if (!['admin','sales_staff'].includes(role) && (role!=='customer' || company?.owner_profile_id!==user.id))
      return response({ error: 'Forbidden' }, 403, headers)
    if (order.status==='cancelled' || Number(order.balance_due)<=0)
      return response({ error: 'Order has no payable balance' }, 409, headers)

    const isDeposit = order.status === 'pending'
      && order.fulfillment_mode === 'made_to_order' && Number(order.deposit_required)>0
    if (order.status==='pending' && !isDeposit)
      return response({ error: 'Order must be confirmed before payment' }, 409, headers)
    const due = Number(order.deposit_required)-Number(order.amount_paid)
    if (isDeposit && due<=0)
      return response({ error: 'Required deposit already paid; await order confirmation' }, 409, headers)

    // A production deposit is ALWAYS server-priced. The caller cannot lower it.
    const requested = Number(body.amount)
    const amount = isDeposit ? Math.round(due*100)/100
      : role==='customer' ? Number(order.balance_due) : requested
    if (!Number.isFinite(amount) || amount<=0 || amount>Number(order.balance_due)
      || !Number.isInteger(Math.round(amount*100)) || Math.abs(amount*100-Math.round(amount*100))>0.001)
      return response({ error: 'Invalid payment amount' }, 400, headers)
    const email = role==='customer' ? user.email : (company?.contact_email || user.email)
    if (!email) return response({ error: 'Payer email is required' }, 400, headers)

    // Exactly one pending deposit checkout per order, including overlapping requests.
    // Reuse the persisted Paystack URL rather than generating multiple chargeable links.
    if (isDeposit) {
      const { data: outstanding } = await admin.from('payment_attempts')
        .select('authorization_url,reference,amount').eq('order_id',orderId)
        .eq('payment_kind','deposit').eq('status','pending').maybeSingle()
      if (outstanding) {
        if (outstanding.authorization_url?.startsWith('https://checkout.paystack.com/')
          && Number(outstanding.amount)===amount)
          return response({ authorization_url:outstanding.authorization_url,reference:outstanding.reference },200,headers)
        return response({ error: 'Unresolved earlier deposit attempt. Please contact Purifa Ventures for reconciliation.' }, 409,headers)
      }
    }

    const reference = `FF-${crypto.randomUUID()}`
    const callback = `${SITE_URL.replace(/\/$/,'')}${role==='customer'?'/customer':'/sales'}`
    const initialize = async () => {
      const tx = await paystack('/transaction/initialize', {
        method:'POST', body:JSON.stringify({ email,amount:String(Math.round(amount*100)),currency:'GHS',reference,
          callback_url:callback,metadata:JSON.stringify({order_id:order.id}) }),
      })
      if (!tx.authorization_url || tx.reference!==reference
        || !String(tx.authorization_url).startsWith('https://checkout.paystack.com/'))
        throw new Error('Unexpected payment checkout response')
      return tx
    }
    if (isDeposit) {
      // Initialize first and persist the URL and attempt together. An exception
      // cannot leave an unusable pending row blocking the customer's next click.
      const tx = await initialize()
      const { error: insertError } = await admin.from('payment_attempts').insert({
        order_id:order.id,amount,currency:'GHS',reference,payment_kind:'deposit',
        authorization_url:tx.authorization_url,initiated_by:user.id,
      })
      if (insertError) return response({error:'A deposit checkout is already in progress. Reload and try Pay Deposit.'},409,headers)
      return response({authorization_url:tx.authorization_url,reference},200,headers)
    }
    const { error: insertError } = await admin.from('payment_attempts').insert({
      order_id:order.id,amount,currency:'GHS',reference,payment_kind:'balance',initiated_by:user.id,
    })
    if (insertError) throw new Error('Could not register payment attempt')
    const tx = await initialize()
    return response({authorization_url:tx.authorization_url,reference},200,headers)
  } catch(e) {
    return response({error:safeError(e)},400,headers)
  }
})
