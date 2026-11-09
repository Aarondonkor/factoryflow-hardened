import { useState } from 'react'
import { Link, Navigate } from 'react-router-dom'
import { useAuthStore } from '@/stores/authStore'
import { useToastStore } from '@/stores/toastStore'
import { BRAND } from '@/lib/brand'
import { Logo } from '@/components/brand/Logo'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { ToastContainer } from '@/components/ui/Toast'

export function CustomerSignupPage() {
  const [contactName, setContactName] = useState('')
  const [businessName, setBusinessName] = useState('')
  const [contactPhone, setContactPhone] = useState('')
  const [address, setAddress] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [submitted, setSubmitted] = useState(false)

  const { user, signUpCustomer } = useAuthStore()
  const addToast = useToastStore((s) => s.addToast)

  if (user) return <Navigate to="/" replace />

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)

    try {
      const { error } = await signUpCustomer({
        email,
        password,
        contactName,
        businessName,
        contactPhone,
        address,
      })

      if (error) {
        addToast(error, 'error')
      } else {
        setSubmitted(true)
      }
    } catch (err) {
      addToast(err instanceof Error ? err.message : 'Something went wrong. Please try again.', 'error')
    } finally {
      setLoading(false)
    }
  }

  if (submitted) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#f4f6f5] p-6">
        <div className="w-full max-w-md card p-8 text-center shadow-elevated">
          <div className="mb-6 flex justify-center">
            <Logo size="md" />
          </div>
          <h1 className="font-display text-xl font-bold text-slate-900">Request received</h1>
          <p className="mt-3 text-sm leading-relaxed text-slate-500">
            Thanks, {contactName.split(' ')[0]}. Check your email to confirm your address, then
            our team will review and approve <span className="font-semibold text-slate-700">{businessName}</span>{' '}
            before you can start placing orders. We'll notify you as soon as you're approved.
          </p>
          <Link to="/login" className="mt-6 inline-block font-semibold text-brand-700 hover:underline">
            Back to sign in
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen grid lg:grid-cols-2">
      <div className="relative hidden overflow-hidden bg-gradient-to-br from-brand-950 via-brand-900 to-brand-800 lg:flex lg:flex-col lg:justify-between p-12">
        <div className="absolute inset-0 opacity-30">
          <div className="absolute -left-20 top-20 h-72 w-72 rounded-full bg-accent-500/20 blur-3xl" />
          <div className="absolute bottom-0 right-0 h-96 w-96 rounded-full bg-brand-500/20 blur-3xl" />
        </div>
        <div className="relative">
          <Logo variant="light" size="lg" />
        </div>
        <div className="relative space-y-6">
          <h2 className="font-display text-4xl font-bold leading-tight text-white max-w-md">
            Order directly from the factory.
          </h2>
          <p className="text-brand-200/90 max-w-md text-lg leading-relaxed">
            Register your company to order branded rolls, unbranded rolls, and packing bag
            bundles from {BRAND.name}, {BRAND.location}.
          </p>
        </div>
        <p className="relative text-xs text-brand-400/70">
          © {new Date().getFullYear()} {BRAND.name}. All rights reserved.
        </p>
      </div>

      <div className="flex items-center justify-center p-6 sm:p-10 bg-[#f4f6f5]">
        <div className="w-full max-w-md">
          <div className="mb-8 lg:hidden">
            <Logo size="md" />
          </div>

          <div className="card p-8 shadow-elevated">
            <div className="mb-8">
              <h1 className="font-display text-2xl font-bold text-slate-900">Create a company account</h1>
              <p className="mt-1.5 text-sm text-slate-500">
                Register to order directly from {BRAND.shortName}
              </p>
            </div>

            <form onSubmit={handleSubmit} className="space-y-5">
              <Input
                label="Company / Business Name"
                value={businessName}
                onChange={(e) => setBusinessName(e.target.value)}
                required
                placeholder="Acme Ltd"
              />
              <Input
                label="Your Name"
                value={contactName}
                onChange={(e) => setContactName(e.target.value)}
                required
                placeholder="Contact person"
              />
              <Input
                label="Phone"
                type="tel"
                value={contactPhone}
                onChange={(e) => setContactPhone(e.target.value)}
                required
                placeholder="024 000 0000"
              />
              <Input
                label="Delivery Address"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                required
                placeholder="Company address"
              />
              <Input
                label="Email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                placeholder="you@company.com"
              />
              <Input
                label="Password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={6}
                placeholder="••••••••"
              />
              <Button type="submit" loading={loading} className="w-full !py-3">
                Create Account
              </Button>
            </form>

            <p className="mt-8 text-center text-sm text-slate-500">
              Already registered?{' '}
              <Link to="/login" className="font-semibold text-brand-700 hover:text-brand-800 hover:underline">
                Sign In
              </Link>
            </p>
          </div>
        </div>
      </div>
      <ToastContainer />
    </div>
  )
}
