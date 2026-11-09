import { reconcilePaystackRefund } from '../_shared/refunds.ts'
import { PAYSTACK_SECRET_KEY, response, safeError, verifyAndSettle } from '../_shared/paystack.ts'

// Paystack supports Paystack-Signature (timestamped secret) and the legacy
// x-paystack-signature. Always HMAC the exact raw body; compare without early exit.
function equalHex(a: string,b: string) {
  if (a.length!==b.length) return false
  let diff=0
  for(let i=0;i<a.length;i++) diff |= a.charCodeAt(i)^b.charCodeAt(i)
  return diff===0
}
async function hmac(secret: string,message: Uint8Array) {
  const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-512'},false,['sign'])
  return Array.from(new Uint8Array(await crypto.subtle.sign('HMAC',key,message))).map(b=>b.toString(16).padStart(2,'0')).join('')
}
async function signatureValid(req: Request, body: Uint8Array) {
  const signed=req.headers.get('Paystack-Signature')
  if (signed) {
    const secret=Deno.env.get('PAYSTACK_WEBHOOK_SIGNING_SECRET')
    if (!secret) return false
    const parts=signed.split(',').map(s=>s.trim())
    const timestamp=parts.find(p=>p.startsWith('t='))?.slice(2)
    if (!timestamp || !/^\d+$/.test(timestamp) || Math.abs(Date.now()/1000-Number(timestamp))>300) return false
    const prefix=new TextEncoder().encode(timestamp+'.')
    const message=new Uint8Array(prefix.length+body.length)
    message.set(prefix);message.set(body,prefix.length)
    const expected=await hmac(secret,message)
    return parts.some(p=>p.startsWith('v1=') && equalHex(p.slice(p.indexOf(':')+1),expected))
  }
  const legacy=req.headers.get('x-paystack-signature')
  if (!legacy || !PAYSTACK_SECRET_KEY) return false
  return equalHex(await hmac(PAYSTACK_SECRET_KEY,body),legacy)
}

Deno.serve(async(req)=>{
  if(req.method!=='POST') return response({error:'Method not allowed'},405)
  const raw=new Uint8Array(await req.arrayBuffer())
  if (raw.byteLength>100000) return response({error:'Request too large'},413)
  if (!(await signatureValid(req,raw))) return response({error:'Invalid webhook signature'},401)
  try {
    const event=JSON.parse(new TextDecoder().decode(raw))
    if(event.event==='charge.success' && typeof event.data?.reference==='string') {
      await verifyAndSettle(event.data.reference)
    }
    if(['refund.processed','refund.failed','refund.processing','refund.needs-attention'].includes(event.event)) {
      const reference=event.data?.refund_reference || event.data?.reference
      if(typeof reference==='string' && /^[A-Za-z0-9_-]{8,64}$/.test(reference)) {
        await reconcilePaystackRefund(reference)
      }
    }
    return response({received:true})
  } catch(e) {
    // Non-2xx response causes Paystack to retry until the ledger has settled.
    return response({error:safeError(e)},503)
  }
})
