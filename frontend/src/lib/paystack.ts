import { supabase } from '@/lib/supabase'

/** Server-verified Paystack checkout: no browser-generated payment references or receipts. */
export async function startVerifiedCheckout(orderId: string, amount?: number): Promise<void> {
  const { data, error } = await supabase.functions.invoke('paystack-payment', {
    body: { action: 'initialize', order_id: orderId, amount },
  })
  if (error || !data?.authorization_url) throw new Error(data?.error || error?.message || 'Checkout initialization failed')
  const url = new URL(data.authorization_url)
  if (url.protocol !== 'https:' || url.hostname !== 'checkout.paystack.com') throw new Error('Invalid payment checkout URL')
  window.location.assign(url.toString())
}

/** After Paystack redirects, validate with the provider on the server before showing success. */
export async function verifyReturnedPayment(): Promise<boolean> {
  const reference = new URLSearchParams(window.location.search).get('reference')
    || new URLSearchParams(window.location.search).get('trxref')
  if (!reference) return false
  // Clear URL even when provider verification fails, so a page refresh cannot replay.
  window.history.replaceState({}, '', window.location.pathname + window.location.hash)
  const { data, error } = await supabase.functions.invoke('paystack-payment', {
    body: { action: 'verify', reference },
  })
  if (error || !data?.ok) throw new Error(data?.error || error?.message || 'Payment is not verified')
  return true
}
