import { admin, cors, response, safeError, userFromRequest } from '../_shared/paystack.ts'

Deno.serve(async(req)=>{
  const headers=cors(req)
  if(req.method==='OPTIONS') return new Response(null,{status:204,headers})
  if(req.method!=='POST') return response({error:'Method not allowed'},405,headers)
  try {
    const {role}=await userFromRequest(req)
    if(role!=='admin') return response({error:'Forbidden'},403,headers)
    const {email,full_name,role:staffRole}=await req.json()
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !['staff','sales_staff','hr_officer','production_supervisor'].includes(staffRole))
      return response({error:'Invalid email or role'},400,headers)
    const {data,error}=await admin.auth.admin.inviteUserByEmail(email,{data:{full_name}})
    if(error || !data.user) throw new Error(error?.message || 'Invitation failed')
    // This RPC deliberately requires an admin user JWT. A service-role connection
    // instead uses a direct trusted admin update, never client-supplied metadata.
    const {error:updateError}=await admin.from('profiles').update({role:staffRole,full_name}).eq('id',data.user.id)
    if(updateError) throw new Error(updateError.message)
    const {error:employeeError}=await admin.from('employees').upsert({
      profile_id:data.user.id,full_name,role_title:staffRole.replaceAll('_',' '),contact_email:email,hire_date:new Date().toISOString().slice(0,10),
    },{onConflict:'profile_id'})
    if(employeeError) throw new Error(employeeError.message)
    await admin.from('customers').delete().eq('owner_profile_id',data.user.id)
    return response({ok:true,invited_email:email},200,headers)
  }catch(e){return response({error:safeError(e)},400,headers)}
})
