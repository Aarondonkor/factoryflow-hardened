import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

export const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
export const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!
export const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
export const PAYSTACK_SECRET_KEY = Deno.env.get('PAYSTACK_SECRET_KEY')!
export const SITE_URL = Deno.env.get('SITE_URL')!
export const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
})

export function cors(request: Request) {
  const origin = request.headers.get('origin') || ''
  const allowed = (Deno.env.get('ALLOWED_ORIGINS') || SITE_URL || '').split(',').map(s => s.trim()).filter(Boolean)
  return {
    'Access-Control-Allow-Origin': allowed.includes(origin) ? origin : (allowed[0] || 'null'),
    'Vary': 'Origin',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  }
}

export function response(body: Record<string, unknown>, status = 200, headers: HeadersInit = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  })
}

export async function userFromRequest(req: Request) {
  const auth = req.headers.get('authorization') || ''
  if (!auth.startsWith('Bearer ')) throw new Error('Sign in required')
  const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: auth } }, auth: { persistSession: false },
  })
  const { data, error } = await client.auth.getUser(auth.slice(7))
  if (error || !data.user) throw new Error('Invalid session')
  const { data: profile, error: profileError } = await admin.from('profiles').select('role').eq('id', data.user.id).single()
  if (profileError || !profile) throw new Error('Profile missing')
  return { user: data.user, role: profile.role as string }
}

export async function paystack(path: string, init?: RequestInit) {
  if (!PAYSTACK_SECRET_KEY) throw new Error('PAYSTACK_SECRET_KEY not configured')
  const result = await fetch('https://api.paystack.co' + path, {
    ...init,
    headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json', ...init?.headers },
  })
  const json = await result.json()
  if (!result.ok || json.status !== true) throw new Error(json.message || 'Payment provider unavailable')
  return json.data
}

export async function verifyAndSettle(reference: string) {
  if (!/^[A-Za-z0-9._=-]{5,100}$/.test(reference)) throw new Error('Invalid reference')
  const { data: attempt, error } = await admin.from('payment_attempts')
    .select('id,order_id,amount,currency,status,provider_transaction_id').eq('reference', reference).single()
  if (error || !attempt) throw new Error('Unknown payment reference')
  const tx = await paystack(`/transaction/verify/${encodeURIComponent(reference)}`)
  if (tx.status !== 'success' || tx.reference !== reference || tx.currency !== 'GHS'
    || !Number.isInteger(tx.amount) || tx.amount !== Math.round(Number(attempt.amount) * 100)
    || !tx.id) throw new Error('Provider has not confirmed the exact GHS payment')
  const metadata = typeof tx.metadata === 'string' ? JSON.parse(tx.metadata) : (tx.metadata || {})
  if (metadata.order_id !== attempt.order_id) throw new Error('Provider order mismatch')
  const { data: inserted, error: settleError } = await admin.rpc('settle_verified_paystack', {
    p_reference: reference, p_provider_id: String(tx.id),
  })
  if (settleError) throw new Error(settleError.message)
  return { settled: inserted === true, order_id: attempt.order_id }
}

export function safeError(error: unknown) {
  // No server secrets, stack traces, tokens, or personal data should reach clients.
  return error instanceof Error ? error.message : 'Request failed'
}
