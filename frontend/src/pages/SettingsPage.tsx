import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { useToastStore } from '@/stores/toastStore'
import type { Profile, UserRole } from '@/types/database'
import { formatDateTime, ROLE_LABELS } from '@/lib/format'
import { BRAND } from '@/lib/brand'
import { Card } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { PageHeader } from '@/components/ui/PageHeader'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'

const staffRoles: UserRole[] = ['staff', 'production_supervisor', 'sales_staff', 'hr_officer']

type StaffCodeRecord = {
  id: string
  employee_name: string
  employee_email: string
  staff_role: UserRole
  created_at: string
  expires_at: string
  redeemed_at: string | null
  revoked_at: string | null
}
type GeneratedCode = Pick<StaffCodeRecord, 'id' | 'employee_name' | 'employee_email' | 'staff_role' | 'expires_at'> & {
  code: string
}
function codeStatus(code: StaffCodeRecord): 'Used' | 'Revoked' | 'Expired' | 'Available' {
  if (code.redeemed_at) return 'Used'
  if (code.revoked_at) return 'Revoked'
  if (new Date(code.expires_at).getTime() <= Date.now()) return 'Expired'
  return 'Available'
}

export function SettingsPage() {
  const profile = useAuthStore(s => s.profile)
  const setProfile = useAuthStore(s => s.setProfile)
  const addToast = useToastStore(s => s.addToast)
  const [fullName, setFullName] = useState(profile?.full_name || '')
  const [password, setPassword] = useState('')
  const [accounts, setAccounts] = useState<Profile[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [staffInfo, setStaffInfo] = useState({ name: '', email: '', role: 'staff' as UserRole, hours: 72 })
  const [codes, setCodes] = useState<StaffCodeRecord[]>([])
  const [generated, setGenerated] = useState<GeneratedCode | null>(null)
  const [codeError, setCodeError] = useState<string | null>(null)
  const [codeBusy, setCodeBusy] = useState(false)
  const isAdmin = profile?.role === 'admin'

  const load = useCallback(async () => {
    if (!isAdmin) return
    const { data, error: dbError } = await supabase.from('profiles').select('*').order('email').limit(100)
    if (dbError) setError(dbError.message)
    else { setAccounts(data || []); setError(null) }
  }, [isAdmin])
  const loadCodes = useCallback(async () => {
    if (!isAdmin) return
    const { data, error: dbError } = await supabase.rpc('admin_list_staff_registration_codes')
    if (dbError) setCodeError(dbError.message)
    else { setCodes((data || []) as StaffCodeRecord[]); setCodeError(null) }
  }, [isAdmin])
  useEffect(() => { void load(); void loadCodes() }, [load, loadCodes])

  const saveName = async () => {
    if (!profile) return
    setBusy(true)
    const { error: dbError } = await supabase.from('profiles').update({ full_name: fullName.trim() }).eq('id', profile.id)
    setBusy(false)
    if (dbError) addToast(dbError.message, 'error')
    else { setProfile({ ...profile, full_name: fullName.trim() }); addToast('Profile updated') }
  }
  const changePassword = async () => {
    if (password.length < 12) { addToast('Use at least 12 characters', 'error'); return }
    setBusy(true)
    const { error: authError } = await supabase.auth.updateUser({ password })
    setBusy(false)
    if (authError) addToast(authError.message, 'error')
    else { setPassword(''); addToast('Password changed') }
  }

  const generateStaffCode = async () => {
    if (codeBusy) return
    setGenerated(null)
    setCodeError(null)
    const name = staffInfo.name.trim()
    const email = staffInfo.email.trim().toLowerCase()
    if (name.length < 2) { setCodeError('Enter the employee’s full name'); return }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setCodeError('Enter the email address the employee will use to register'); return
    }
    setCodeBusy(true)
    try {
      const { data, error: dbError } = await supabase.rpc('admin_create_staff_registration_code', {
        p_employee_name: name,
        p_employee_email: email,
        p_role: staffInfo.role,
        p_valid_hours: staffInfo.hours,
      })
      if (dbError) throw dbError
      if (!data || typeof data.code !== 'string') throw new Error('No registration code returned')
      setGenerated(data as GeneratedCode)
      setStaffInfo({ name: '', email: '', role: 'staff', hours: 72 })
      addToast('Employee registration code generated')
      await loadCodes()
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'Could not generate code'
      setCodeError(message)
      addToast(message, 'error')
    } finally { setCodeBusy(false) }
  }
  const copyStaffCode = async () => {
    if (!generated) return
    try { await navigator.clipboard.writeText(generated.code); addToast('Code copied') }
    catch { addToast('Copy the code manually from the field', 'error') }
  }
  const revokeStaffCode = async (item: StaffCodeRecord) => {
    if (!window.confirm(`Revoke the registration code for ${item.employee_name}?`)) return
    setCodeBusy(true)
    setCodeError(null)
    const { error: dbError } = await supabase.rpc('admin_revoke_staff_registration_code', { p_code_id: item.id })
    setCodeBusy(false)
    if (dbError) { setCodeError(dbError.message); addToast(dbError.message, 'error') }
    else {
      if (generated?.id === item.id) setGenerated(null)
      addToast('Registration code revoked')
      void loadCodes()
    }
  }
  const updateRole = async (id: string, role: UserRole) => {
    if (!window.confirm(`Grant ${ROLE_LABELS[role]} to this account?`)) return
    const { error: dbError } = await supabase.rpc('admin_set_staff_role', { p_user: id, p_role: role })
    if (dbError) addToast(dbError.message, 'error')
    else { addToast('Account role updated'); void load() }
  }

  return <div className="page-shell max-w-4xl space-y-6">
    <PageHeader title="Settings" subtitle="Account security and employee registration" />
    <Card title="My Account"><div className="space-y-3">
      <p className="text-sm text-slate-600">{profile?.email} · <Badge variant="info">{ROLE_LABELS[profile?.role || 'staff']}</Badge></p>
      <Input label="Full Name" value={fullName} onChange={e => setFullName(e.target.value)} />
      <Button onClick={saveName} loading={busy}>Save Profile</Button>
      <Input label="New Password (12+ characters)" type="password" minLength={12} value={password} onChange={e => setPassword(e.target.value)} />
      <Button variant="secondary" onClick={changePassword} loading={busy}>Change Password</Button>
    </div></Card>

    {isAdmin && <>
      <Card title="Generate Employee Registration Code"><div className="space-y-4">
        <p className="text-sm text-slate-600">Create a one-time code for a recognized Purifa Ventures employee. The code assigns the role you select and only works with the specified email address. No invitation email is sent.</p>
        {codeError && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700" role="alert">{codeError}</p>}
        <Input id="staff-code-employee-name" label="Employee full name" required value={staffInfo.name} onChange={e => setStaffInfo({ ...staffInfo, name: e.target.value })} placeholder="Employee's legal name" />
        <Input id="staff-code-employee-email" label="Employee registration email" type="email" required value={staffInfo.email} onChange={e => setStaffInfo({ ...staffInfo, email: e.target.value })} placeholder="employee@example.com" />
        <div className="grid gap-3 sm:grid-cols-2">
          <Select id="staff-code-role" label="Role to assign" value={staffInfo.role} onChange={e => setStaffInfo({ ...staffInfo, role: e.target.value as UserRole })}>
            {staffRoles.map(r => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
          </Select>
          <Select id="staff-code-expiration" label="Code expires after" value={staffInfo.hours} onChange={e => setStaffInfo({ ...staffInfo, hours: Number(e.target.value) })}>
            <option value={24}>24 hours</option><option value={48}>48 hours</option><option value={72}>72 hours</option><option value={168}>7 days</option>
          </Select>
        </div>
        <Button onClick={generateStaffCode} loading={codeBusy} disabled={staffInfo.name.trim().length < 2 || !staffInfo.email.trim()}>Generate Registration Code</Button>
        {generated && <div className="rounded-xl border-2 border-brand-200 bg-brand-50 p-4 space-y-3" role="status">
          <p className="font-semibold text-brand-950">New code — shown only once</p>
          <p className="text-sm text-slate-700">For <strong>{generated.employee_name}</strong> ({generated.employee_email}), role: <strong>{ROLE_LABELS[generated.staff_role]}</strong>. Expires {formatDateTime(generated.expires_at)}.</p>
          <Input id="generated-staff-code" label="Share this code privately with the employee" value={generated.code} readOnly onFocus={e => e.target.select()} />
          <Button variant="secondary" onClick={copyStaffCode}>Copy Code</Button>
          <p className="text-xs text-slate-600">The code is not stored in readable form. Copy it now: it cannot be displayed again after leaving this page. Give the employee the <Link to="/staff/signup" className="font-semibold underline">Employee Sign Up</Link> link.</p>
        </div>}
      </div></Card>
      <Card title="Employee Registration Codes"><div className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs text-slate-600">Last 100 generated codes; plaintext codes are never listed.</p>
          <Button variant="secondary" onClick={() => void loadCodes()} disabled={codeBusy}>Refresh</Button>
        </div>
        {codes.length === 0 && <p className="text-sm text-slate-500">No employee codes generated yet.</p>}
        <div className="max-h-80 space-y-2 overflow-auto">
          {codes.map(item => {
            const status = codeStatus(item)
            return <div key={item.id} className="flex flex-wrap items-center justify-between gap-3 border-b py-3">
              <div className="min-w-0 space-y-1">
                <p className="text-sm font-medium">{item.employee_name} <span className="font-normal text-slate-600">· {ROLE_LABELS[item.staff_role]}</span></p>
                <p className="text-xs text-slate-500 break-all">{item.employee_email} · Expires {formatDateTime(item.expires_at)}</p>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant={status === 'Available' ? 'success' : 'default'}>{status}</Badge>
                {status === 'Available' && <Button variant="danger" onClick={() => void revokeStaffCode(item)} disabled={codeBusy}>Revoke</Button>}
              </div>
            </div>
          })}
        </div>
      </div></Card>
      <Card title="Manage Existing Accounts">
        {error && <p className="text-red-700 text-sm" role="alert">{error}</p>}
        <div className="space-y-2 max-h-96 overflow-auto">
          {accounts.map(a => <div className="flex items-center justify-between gap-3 border-b py-2" key={a.id}>
            <div className="min-w-0"><p className="truncate text-sm font-medium">{a.full_name || a.email}</p>
              <p className="text-xs text-slate-500 truncate">{a.email} · {ROLE_LABELS[a.role]}</p></div>
            {a.role !== 'admin' && <Select value={a.role === 'customer' ? '' : a.role} onChange={e => void updateRole(a.id, e.target.value as UserRole)}>
              <option value="">Promote / assign</option>{staffRoles.map(r => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
            </Select>}
          </div>)}
        </div>
      </Card>
    </>}
    <Card title="Organisation"><p className="text-sm">{BRAND.name} · {BRAND.appName} · GHS</p></Card>
  </div>
}
