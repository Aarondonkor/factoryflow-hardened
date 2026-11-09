import { useCallback, useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { useToastStore } from '@/stores/toastStore'
import type { Profile, UserRole } from '@/types/database'
import { ROLE_LABELS } from '@/lib/format'
import { BRAND } from '@/lib/brand'
import { Card } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { PageHeader } from '@/components/ui/PageHeader'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'

const staffRoles:UserRole[]=['staff','production_supervisor','sales_staff','hr_officer']
export function SettingsPage() {
  const profile=useAuthStore(s=>s.profile)
  const setProfile=useAuthStore(s=>s.setProfile)
  const addToast=useToastStore(s=>s.addToast)
  const [fullName,setFullName]=useState(profile?.full_name||'')
  const [password,setPassword]=useState('')
  const [invitation,setInvitation]=useState({email:'',name:'',role:'staff' as UserRole})
  const [accounts,setAccounts]=useState<Profile[]>([])
  const [busy,setBusy]=useState(false)
  const [error,setError]=useState<string|null>(null)
  const isAdmin=profile?.role==='admin'
  const load=useCallback(async()=>{
    if(!isAdmin)return
    const {data,error:dbError}=await supabase.from('profiles').select('*').order('email').limit(100)
    if(dbError)setError(dbError.message)
    else{setAccounts(data||[]);setError(null)}
  },[isAdmin])
  useEffect(()=>{void load()},[load])
  const saveName=async()=>{
    if(!profile)return
    setBusy(true)
    const {error:dbError}=await supabase.from('profiles').update({full_name:fullName.trim()}).eq('id',profile.id)
    setBusy(false)
    if(dbError)addToast(dbError.message,'error')
    else{setProfile({...profile,full_name:fullName.trim()});addToast('Profile updated')}
  }
  const changePassword=async()=>{
    if(password.length<12){addToast('Use at least 12 characters','error');return}
    setBusy(true)
    const {error:authError}=await supabase.auth.updateUser({password})
    setBusy(false)
    if(authError)addToast(authError.message,'error')
    else{setPassword('');addToast('Password changed')}
  }
  const invite=async()=>{
    setBusy(true)
    const {data,error:fnError}=await supabase.functions.invoke('admin-invite-staff',{
      body:{email:invitation.email,full_name:invitation.name,role:invitation.role},
    })
    setBusy(false)
    if(fnError||data?.error)addToast(data?.error||fnError?.message||'Could not invite staff','error')
    else{addToast('Staff invitation sent');setInvitation({email:'',name:'',role:'staff'});load()}
  }
  const updateRole=async(id:string,role:UserRole)=>{
    if(!window.confirm(`Grant ${ROLE_LABELS[role]} to this account?`))return
    const {error:dbError}=await supabase.rpc('admin_set_staff_role',{p_user:id,p_role:role})
    if(dbError)addToast(dbError.message,'error')
    else{addToast('Account role updated');load()}
  }
  return <div className="page-shell max-w-3xl space-y-6">
    <PageHeader title="Settings" subtitle="Account security and staff access management" />
    <Card title="My Account"><div className="space-y-3">
      <p className="text-sm text-slate-600">{profile?.email} · <Badge variant="info">{ROLE_LABELS[profile?.role||'staff']}</Badge></p>
      <Input label="Full Name" value={fullName} onChange={e=>setFullName(e.target.value)}/>
      <Button onClick={saveName} loading={busy}>Save Profile</Button>
      <Input label="New Password (12+ characters)" type="password" minLength={12} value={password} onChange={e=>setPassword(e.target.value)}/>
      <Button variant="secondary" onClick={changePassword} loading={busy}>Change Password</Button>
    </div></Card>
    {isAdmin && <>
      <Card title="Invite a Staff Member"><div className="space-y-3">
        <p className="text-xs text-slate-600">Only administrators can invite staff. Public signup never grants staff or admin roles.</p>
        <Input label="Work Email" type="email" value={invitation.email} onChange={e=>setInvitation({...invitation,email:e.target.value})}/>
        <Input label="Full Name" value={invitation.name} onChange={e=>setInvitation({...invitation,name:e.target.value})}/>
        <Select label="Assigned Role" value={invitation.role} onChange={e=>setInvitation({...invitation,role:e.target.value as UserRole})}>
          {staffRoles.map(r=><option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
        </Select>
        <Button loading={busy} onClick={invite}>Send Staff Invitation</Button>
      </div></Card>
      <Card title="Manage Existing Accounts">
        {error && <p className="text-red-700 text-sm" role="alert">{error}</p>}
        <div className="space-y-2 max-h-96 overflow-auto">
          {accounts.map(a=><div className="flex items-center justify-between gap-3 border-b py-2" key={a.id}>
            <div className="min-w-0"><p className="truncate text-sm font-medium">{a.full_name||a.email}</p>
              <p className="text-xs text-slate-500 truncate">{a.email} · {ROLE_LABELS[a.role]}</p></div>
            {a.role!=='admin' && <Select value={a.role==='customer'?'':a.role} onChange={e=>updateRole(a.id,e.target.value as UserRole)}>
              <option value="">Promote / assign</option>{staffRoles.map(r=><option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
            </Select>}
          </div>)}
        </div>
      </Card>
    </>}
    <Card title="Organisation"><p className="text-sm">{BRAND.name} · {BRAND.appName} · GHS</p></Card>
  </div>
}
