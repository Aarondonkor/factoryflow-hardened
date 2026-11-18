import { supabase } from '@/lib/supabase'

/** Show the safe server-side error message rather than Supabase's generic non-2xx text. */
async function getEdgeError(error: unknown, fallback: string): Promise<string> {
  const context = (error as { context?: unknown } | null)?.context
  if (context instanceof Response) {
    try {
      const payload: unknown = await context.clone().json()
      if (payload && typeof payload === 'object' && 'error' in payload) {
        const message = (payload as { error: unknown }).error
        if (typeof message === 'string' && message.trim()) return message
      }
    } catch { /* Response may have no JSON body */ }
    return `${fallback} (HTTP ${context.status})`
  }
  return error instanceof Error ? error.message : fallback
}

/** Server-verified Paystack checkout: no browser-generated payment references or receipts. */
export async function startVerifiedCheckout(orderId: string, amount?: number): Promise<void> {
  const { data, error } = await supabase.functions.invoke('paystack-payment', {
    body: { action: 'initialize', order_id: orderId, amount },
  })
  if (error) throw new Error(await getEdgeError(error, 'Checkout initialization failed'))
  if (!data?.authorization_url) throw new Error(data?.error || 'Checkout initialization failed')
  const url = new URL(data.authorization_url)
  if (url.protocol !== 'https:' || url.hostname !== 'checkout.paystack.com') throw new Error('Invalid payment checkout URL')
  window.location.assign(url.toString())
}

/** After Paystack redirects, validate with the provider on the server before showing success. */
export async function verifyReturnedPayment(): Promise<boolean> {
  const params = new URLSearchParams(window.location.search)
  const reference = params.get('reference') || params.get('trxref')
  if (!reference) return false
  // Preserve the callback reference until the server verifies the transaction.
  // If verification temporarily fails, reloading the page can safely retry it.
  const { data, error } = await supabase.functions.invoke('paystack-payment', {
    body: { action: 'verify', reference },
  })
  if (error) throw new Error(await getEdgeError(error, 'Payment is not verified'))
  if (!data?.ok) throw new Error(data?.error || 'Payment is not verified')
  // Remove only Paystack callback parameters after successful verification.
  params.delete('reference')
  params.delete('trxref')
  const query = params.toString()
  window.history.replaceState(window.history.state, '', window.location.pathname + (query ? `?${query}` : '') + window.location.hash)
  return true
}
