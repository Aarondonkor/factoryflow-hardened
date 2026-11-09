import { Navigate } from 'react-router-dom'
import { useAuthStore } from '@/stores/authStore'

type Module = 'dashboard' | 'production' | 'inventory' | 'sales' | 'hr' | 'settings'

export function RoleRoute({
  module,
  children,
}: {
  module: Module
  children: React.ReactNode
}) {
  const canAccessModule = useAuthStore((s) => s.canAccessModule)

  if (!canAccessModule(module)) {
    return <Navigate to="/" replace />
  }

  return <>{children}</>
}
