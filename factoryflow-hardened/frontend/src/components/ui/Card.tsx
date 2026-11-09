import type { ReactNode } from 'react'

interface CardProps {
  title?: string
  subtitle?: string
  children: ReactNode
  className?: string
  action?: ReactNode
}

export function Card({ title, subtitle, children, className = '', action }: CardProps) {
  return (
    <div className={`card overflow-hidden ${className}`}>
      {(title || action) && (
        <div className="flex items-start justify-between gap-4 border-b border-slate-100 bg-slate-50/50 px-6 py-4">
          <div>
            {title && <h3 className="font-display font-bold text-slate-900">{title}</h3>}
            {subtitle && <p className="mt-0.5 text-xs text-slate-500">{subtitle}</p>}
          </div>
          {action}
        </div>
      )}
      <div className="p-6">{children}</div>
    </div>
  )
}

interface StatCardProps {
  label: string
  value: string | number
  subtext?: string
  alert?: boolean
  icon?: ReactNode
}

export function StatCard({ label, value, subtext, alert, icon }: StatCardProps) {
  return (
    <div
      className={`card relative overflow-hidden p-5 transition-shadow hover:shadow-elevated ${
        alert ? 'border-amber-300/80 bg-gradient-to-br from-amber-50 to-white' : ''
      }`}
    >
      {!alert && (
        <div className="absolute -right-4 -top-4 h-20 w-20 rounded-full bg-brand-500/5" />
      )}
      <div className="relative flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-bold uppercase tracking-[0.14em] text-slate-500">{label}</p>
          <p className={`mt-2 font-display text-2xl font-bold tracking-tight ${alert ? 'text-amber-800' : 'text-slate-900'}`}>
            {value}
          </p>
          {subtext && <p className="mt-1.5 text-xs font-medium text-slate-400">{subtext}</p>}
        </div>
        {icon && (
          <div className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ${
            alert ? 'bg-amber-100 text-amber-700' : 'bg-brand-50 text-brand-700'
          }`}>
            {icon}
          </div>
        )}
      </div>
    </div>
  )
}
