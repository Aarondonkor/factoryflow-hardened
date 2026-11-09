import { Navigate } from 'react-router-dom'
import { useAuthStore } from '@/stores/authStore'
import type { UserRole } from '@/types/database'

interface RoleGateProps {
  allow: (role: UserRole) => boolean
  redirectTo: string
  children: React.ReactNode
}

export function RoleGate({ allow, redirectTo, children }: RoleGateProps) {
  const profile = useAuthStore((s) => s.profile)

  if (!profile) return null
  if (!allow(profile.role)) return <Navigate to={redirectTo} replace />

  return <>{children}</>
}
