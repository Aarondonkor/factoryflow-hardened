import { Outlet } from 'react-router-dom'
import { useAuthStore } from '@/stores/authStore'
import { BRAND } from '@/lib/brand'
import { Logo } from '@/components/brand/Logo'
import { NotificationBell } from '@/components/notifications/NotificationBell'
import { ToastContainer } from '@/components/ui/Toast'
import { LogoutIcon } from '@/components/icons/NavIcons'

export function CustomerLayout() {
  const signOut = useAuthStore((s) => s.signOut)
  const profile = useAuthStore((s) => s.profile)

  return (
    <div className="min-h-screen bg-[#f4f6f5]">
      <header className="sticky top-0 z-30 border-b border-slate-200/80 bg-white/90 px-4 backdrop-blur-md lg:px-6">
        <div className="mx-auto flex h-[4.25rem] max-w-5xl items-center justify-between gap-4">
          <Logo size="md" />
          <div className="flex items-center gap-3">
            <div className="hidden text-right sm:block">
              <p className="text-sm font-semibold text-slate-700">{profile?.full_name || 'Customer'}</p>
              <p className="text-xs text-slate-500">{BRAND.shortName} Customer Portal</p>
            </div>
            <NotificationBell />
            <button
              onClick={() => signOut()}
              className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3.5 py-2 text-sm font-semibold text-slate-700 shadow-sm transition-all hover:border-slate-300 hover:bg-slate-50"
            >
              <LogoutIcon className="h-4 w-4" />
              <span className="hidden sm:inline">Sign Out</span>
            </button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-5xl p-4 lg:p-8">
        <Outlet />
      </main>
      <ToastContainer />
    </div>
  )
}
