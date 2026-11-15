import { useState } from 'react'
import { Link, Navigate } from 'react-router-dom'
import { useAuthStore } from '@/stores/authStore'
import { Logo } from '@/components/brand/Logo'
import { BRAND } from '@/lib/brand'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'

export function StaffSignupPage() {
  const user = useAuthStore(s => s.user)
  const signUpStaff = useAuthStore(s => s.signUpStaff)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [submitted, setSubmitted] = useState(false)

  if (user) return <Navigate to="/" replace />

  const register = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    if (password.length < 12) { setError('Password must be at least 12 characters'); return }
    if (password !== confirm) { setError('Passwords do not match'); return }
    if (!/^PV-[0-9A-F]{8}(-[0-9A-F]{8}){3}$/.test(code.trim().toUpperCase())) {
      setError('Enter the complete registration code provided by your administrator'); return
    }
    setBusy(true)
    try {
      const result = await signUpStaff({ email: email.trim().toLowerCase(), password, code: code.trim().toUpperCase() })
      if (result.error) {
        setError(/database error saving new user|invalid employee registration code/i.test(result.error)
          ? 'Registration could not be completed. Check that the code is correct, unused, unexpired, and assigned to this exact email address.'
          : result.error)
      } else {
        setSubmitted(true)
        setPassword('')
        setConfirm('')
        setCode('')
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not create account')
    } finally { setBusy(false) }
  }

  return <div className="min-h-screen bg-[#f4f6f5] flex items-center justify-center px-4 py-12">
    <div className="card w-full max-w-md p-8 shadow-elevated space-y-5">
      <div className="flex justify-center"><Logo size="md" /></div>
      {submitted ? <>
        <h1 className="font-display text-2xl font-bold">Registration submitted</h1>
        <p className="text-sm leading-relaxed text-slate-600">Your {BRAND.name} staff account has been registered. If email confirmation is enabled, confirm your address before signing in. The registration code cannot be used again.</p>
        <Link className="font-semibold text-brand-700 underline" to="/login">Go to Sign In</Link>
      </> : <>
        <div>
          <h1 className="font-display text-2xl font-bold">Employee Sign Up</h1>
          <p className="mt-2 text-sm text-slate-600">For recognized {BRAND.name} employees only. Your administrator must provide a personal registration code that sets your role automatically.</p>
        </div>
        {error && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700" role="alert">{error}</p>}
        <form onSubmit={register} className="space-y-4">
          <Input id="staff-registration-email" label="Your registered email" type="email" autoComplete="email" required value={email} onChange={e => setEmail(e.target.value)} placeholder="Use the email specified by your administrator" />
          <Input id="staff-registration-code" label="Employee registration code" type="text" autoComplete="off" required value={code} onChange={e => setCode(e.target.value.toUpperCase())} placeholder="PV-XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX" />
          <Input id="staff-registration-password" label="Create password (12+ characters)" type="password" minLength={12} autoComplete="new-password" required value={password} onChange={e => setPassword(e.target.value)} />
          <Input id="staff-registration-confirm" label="Confirm password" type="password" minLength={12} autoComplete="new-password" required value={confirm} onChange={e => setConfirm(e.target.value)} />
          <Button className="w-full" type="submit" loading={busy}>Create Employee Account</Button>
        </form>
        <p className="text-sm text-center text-slate-500">Already have an account? <Link className="font-semibold text-brand-700 underline" to="/login">Sign In</Link></p>
        <p className="text-xs text-center text-slate-500">Are you a customer? <Link className="font-semibold text-brand-700 underline" to="/customer/signup">Create a company account</Link></p>
      </>}
    </div>
  </div>
}
