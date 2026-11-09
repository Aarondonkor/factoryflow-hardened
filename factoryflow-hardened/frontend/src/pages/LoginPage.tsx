import { useState } from 'react'
import { Link, Navigate } from 'react-router-dom'
import { useAuthStore } from '@/stores/authStore'
import { useToastStore } from '@/stores/toastStore'
import { BRAND } from '@/lib/brand'
import { Logo } from '@/components/brand/Logo'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { ToastContainer } from '@/components/ui/Toast'

export function LoginPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)

  const { user, signIn } = useAuthStore()
  const addToast = useToastStore((s) => s.addToast)

  if (user) return <Navigate to="/" replace />

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)

    const result = await signIn(email, password)

    setLoading(false)

    if (result.error) {
      addToast(result.error, 'error')
    }
  }

  return (
    <div className="min-h-screen grid lg:grid-cols-2">
      {/* Brand panel */}
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
            Factory operations, unified.
          </h2>
          <p className="text-brand-200/90 max-w-md text-lg leading-relaxed">
            Manage production, inventory, sales, and HR for {BRAND.name} — {BRAND.tagline.toLowerCase()}, {BRAND.location}.
          </p>
          <div className="flex gap-6 pt-4">
            {['Production', 'Inventory', 'Sales', 'HR'].map((item) => (
              <div key={item} className="text-center">
                <div className="mx-auto mb-2 h-1 w-8 rounded-full bg-accent-500" />
                <span className="text-xs font-semibold uppercase tracking-wider text-brand-300">{item}</span>
              </div>
            ))}
          </div>
        </div>
        <p className="relative text-xs text-brand-400/70">
          © {new Date().getFullYear()} {BRAND.name}. All rights reserved.
        </p>
      </div>

      {/* Form panel */}
      <div className="flex items-center justify-center p-6 sm:p-10 bg-[#f4f6f5]">
        <div className="w-full max-w-md">
          <div className="mb-8 lg:hidden">
            <Logo size="md" />
            <p className="mt-2 text-sm text-slate-500">{BRAND.tagline}</p>
          </div>

          <div className="card p-8 shadow-elevated">
            <div className="mb-8">
              <h1 className="font-display text-2xl font-bold text-slate-900">
                Welcome back
              </h1>
              <p className="mt-1.5 text-sm text-slate-500">
                Sign in to {BRAND.appName}. Staff accounts are invited by an administrator.
              </p>
            </div>

            <form onSubmit={handleSubmit} className="space-y-5">
              <Input
                label="Email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                placeholder="you@purifaventures.com"
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
                Sign In
              </Button>
            </form>

            <p className="mt-3 text-center text-sm text-slate-500">
              Ordering as a customer?{' '}
              <Link to="/customer/signup" className="font-semibold text-brand-700 hover:text-brand-800 hover:underline">
                Create a company account
              </Link>
            </p>
          </div>
        </div>
      </div>
      <ToastContainer />
    </div>
  )
}
