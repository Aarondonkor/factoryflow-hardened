import { useAuthStore } from '@/stores/authStore'
import { formatDate } from '@/lib/format'
import { BRAND } from '@/lib/brand'
import { LogoutIcon } from '@/components/icons/NavIcons'

interface HeaderProps {
  onMenuClick: () => void
  title: string
}

export function Header({ onMenuClick, title }: HeaderProps) {
  const signOut = useAuthStore((s) => s.signOut)
  const profile = useAuthStore((s) => s.profile)
  const today = formatDate(new Date())

  return (
    <header className="sticky top-0 z-30 border-b border-slate-200/80 bg-white/90 px-4 backdrop-blur-md lg:px-6">
      <div className="flex h-[4.25rem] items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-4">
          <button
            onClick={onMenuClick}
            className="rounded-xl border border-slate-200 p-2.5 text-slate-600 transition-colors hover:bg-slate-50 lg:hidden"
            aria-label="Open menu"
          >
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
          <div className="min-w-0">
            <p className="truncate text-[11px] font-bold uppercase tracking-[0.18em] text-brand-600">
              {BRAND.name}
            </p>
            <h2 className="truncate font-display text-xl font-bold text-slate-900">{title}</h2>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <div className="hidden text-right sm:block">
            <p className="text-xs font-medium text-slate-500">{today}</p>
            <p className="text-sm font-semibold text-slate-700">{profile?.full_name?.split(' ')[0] || 'User'}</p>
          </div>
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
  )
}
