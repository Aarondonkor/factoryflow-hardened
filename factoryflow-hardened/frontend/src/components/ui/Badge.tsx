interface BadgeProps {
  variant?: 'default' | 'success' | 'warning' | 'danger' | 'info'
  children: React.ReactNode
}

export function Badge({ variant = 'default', children }: BadgeProps) {
  const variants = {
    default: 'bg-slate-100 text-slate-700 ring-1 ring-slate-200',
    success: 'bg-emerald-50 text-emerald-800 ring-1 ring-emerald-200',
    warning: 'bg-amber-50 text-amber-800 ring-1 ring-amber-200',
    danger: 'bg-red-50 text-red-800 ring-1 ring-red-200',
    info: 'bg-brand-50 text-brand-800 ring-1 ring-brand-200',
  }

  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ${variants[variant]}`}>
      {children}
    </span>
  )
}

export function getStockBadge(stock: number, threshold: number) {
  if (threshold > 0 && stock <= threshold) return 'danger' as const
  if (threshold > 0 && stock <= threshold * 1.5) return 'warning' as const
  return 'success' as const
}

export function getOrderStatusBadge(status: string) {
  const map: Record<string, 'default' | 'success' | 'warning' | 'danger' | 'info'> = {
    pending: 'warning',
    confirmed: 'info',
    in_production: 'info',
    dispatched: 'info',
    delivered: 'success',
    paid: 'success',
    cancelled: 'danger',
  }
  return map[status] || 'default'
}

export function getDeliveryStatusBadge(status: string) {
  const map: Record<string, 'default' | 'success' | 'warning' | 'danger' | 'info'> = {
    pending: 'default',
    dispatched: 'info',
    delivered: 'success',
  }
  return map[status] || 'default'
}
