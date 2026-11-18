import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const url = Deno.env.get('SUPABASE_URL')!
const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const siteOrigin = Deno.env.get('ALLOWED_ORIGINS') || Deno.env.get('SITE_URL') || ''
const admin = createClient(url, serviceKey, { auth: { persistSession:false, autoRefreshToken:false } })
function headers(req: Request) {
  const origin=req.headers.get('origin') || ''
  const allowed=siteOrigin.split(',').map(x=>x.trim()).filter(Boolean)
  return { 'Access-Control-Allow-Origin': allowed.includes(origin)?origin:'null',
    'Access-Control-Allow-Headers':'authorization, apikey, content-type, x-client-info',
    'Access-Control-Allow-Methods':'POST, OPTIONS','Vary':'Origin',
    'Content-Type':'application/json','Cache-Control':'no-store' }
}
function answer(req:Request,status:number,body:Record<string,unknown>) {
  return new Response(JSON.stringify(body),{status,headers:headers(req)})
}
Deno.serve(async req=>{
  if(req.method==='OPTIONS') return new Response(null,{status:204,headers:headers(req)})
  if(req.method!=='POST') return answer(req,405,{error:'Method not allowed'})
  const origin=req.headers.get('origin') || ''
  if(origin && !siteOrigin.split(',').map(x=>x.trim()).includes(origin))
    return answer(req,403,{error:'Origin not allowed'})
  try {
    const token=(req.headers.get('authorization') || '').replace(/^Bearer\s+/i,'')
    if(!token) return answer(req,401,{error:'Sign in required'})
    const {data:{user},error:authError}=await admin.auth.getUser(token)
    if(authError || !user) return answer(req,401,{error:'Invalid session'})
    const {data:profile,error:roleError}=await admin.from('profiles').select('role').eq('id',user.id).single()
    if(roleError || profile?.role!=='admin') return answer(req,403,{error:'Administrator required'})
    const { customer_id, retry_cleanup } = await req.json()
    if(typeof customer_id!=='string' || !/^[0-9a-f-]{36}$/i.test(customer_id))
      return answer(req,400,{error:'Invalid customer id'})
    const caller=createClient(url,anonKey,{global:{headers:{Authorization:`Bearer ${token}`}},auth:{persistSession:false}})
    const {data:owner,error:deleteError}=await caller.rpc(
      retry_cleanup?'admin_get_pending_rejected_auth_cleanup':'admin_delete_rejected_customer',
      {p_customer:customer_id})
    if(deleteError) return answer(req,409,{error:deleteError.message})
    if(!owner) return answer(req,200,{ok:true,message:'Rejected registration removed; no linked authentication account'})
    const {error:removeError}=await admin.auth.admin.deleteUser(owner)
    if(removeError && !/not found/i.test(removeError.message)) {
      console.error('Rejected registration auth cleanup failed',customer_id,removeError.message)
      return answer(req,207,{ok:false,partial:true,error:'Registration removed; authentication cleanup needs retry',customer_id})
    }
    const {error:logError}=await admin.from('rejected_customer_deletion_log')
      .update({auth_deleted_at:new Date().toISOString()}).eq('customer_id',customer_id).is('auth_deleted_at',null)
    if(logError) console.error('Could not mark deletion audit',customer_id,logError.message)
    return answer(req,200,{ok:true,message:'Rejected registration and authentication account deleted'})
  } catch(e) {
    console.error('Delete rejected customer failed',e)
    return answer(req,500,{error:'Unable to process deletion; check Edge Function logs'})
  }
})
