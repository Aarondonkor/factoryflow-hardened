import { NavLink } from 'react-router-dom'
import { useAuthStore } from '@/stores/authStore'
import { ROLE_LABELS } from '@/lib/format'
import { BRAND } from '@/lib/brand'
import { Logo } from '@/components/brand/Logo'
import {
  DashboardIcon,
  ProductionIcon,
  InventoryIcon,
  SalesIcon,
  HRIcon,
  SettingsIcon,
} from '@/components/icons/NavIcons'

const navItems = [
  { path: '/', label: 'Dashboard', Icon: DashboardIcon, module: 'dashboard' as const },
  { path: '/production', label: 'Production', Icon: ProductionIcon, module: 'production' as const },
  { path: '/inventory', label: 'Inventory', Icon: InventoryIcon, module: 'inventory' as const },
  { path: '/sales', label: 'Sales', Icon: SalesIcon, module: 'sales' as const },
  { path: '/hr', label: 'HR', Icon: HRIcon, module: 'hr' as const },
  { path: '/settings', label: 'Settings', Icon: SettingsIcon, module: 'settings' as const },
]

interface SidebarProps {
  open: boolean
  onClose: () => void
}

export function Sidebar({ open, onClose }: SidebarProps) {
  const canAccessModule = useAuthStore((s) => s.canAccessModule)
  const profile = useAuthStore((s) => s.profile)
  const visibleItems = navItems.filter((item) => canAccessModule(item.module))

  return (
    <>
      {open && (
        <div className="fixed inset-0 z-40 bg-brand-950/60 backdrop-blur-sm lg:hidden" onClick={onClose} />
      )}
      <aside
        className={`fixed top-0 left-0 z-50 flex h-full w-[17.5rem] flex-col bg-gradient-to-b from-brand-950 via-brand-900 to-brand-950 text-white transform transition-transform duration-300 lg:translate-x-0 lg:static lg:z-auto ${
          open ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="relative shrink-0 overflow-hidden px-5 py-6 border-b border-white/10">
          <div className="absolute -top-8 -right-8 h-32 w-32 rounded-full bg-accent-500/10 blur-2xl" />
          <Logo variant="light" size="md" />
          <p className="mt-3 text-[11px] font-medium uppercase tracking-[0.2em] text-brand-300/80">
            {BRAND.tagline}
          </p>
        </div>

        <nav className="flex-1 overflow-y-auto p-3 space-y-1">
          <p className="px-3 pt-2 pb-1 text-[10px] font-bold uppercase tracking-[0.22em] text-brand-400/70">
            Operations
          </p>
          {visibleItems.map(({ path, label, Icon }) => (
            <NavLink
              key={path}
              to={path}
              end={path === '/'}
              onClick={onClose}
              className={({ isActive }) =>
                `group flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-all duration-200 ${
                  isActive
                    ? 'bg-white/12 text-white shadow-inner ring-1 ring-white/10'
                    : 'text-brand-200/90 hover:bg-white/8 hover:text-white'
                }`
              }
            >
              {({ isActive }) => (
                <>
                  <span
                    className={`flex h-8 w-8 items-center justify-center rounded-lg transition-colors ${
                      isActive ? 'bg-accent-500/20 text-accent-400' : 'bg-white/5 text-brand-300 group-hover:text-accent-400'
                    }`}
                  >
                    <Icon className="h-[18px] w-[18px]" />
                  </span>
                  {label}
                </>
              )}
            </NavLink>
          ))}
        </nav>

        {profile && (
          <div className="shrink-0 border-t border-white/10 bg-black/20 p-4 backdrop-blur-sm">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-accent-500 to-accent-600 text-sm font-bold text-brand-950">
                {(profile.full_name || profile.email).charAt(0).toUpperCase()}
              </div>
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold">{profile.full_name || profile.email}</p>
                <p className="truncate text-xs text-brand-300">{ROLE_LABELS[profile.role]}</p>
              </div>
            </div>
          </div>
        )}
      </aside>
    </>
  )
}
