import { BRAND } from '@/lib/brand'
import { formatDate } from '@/lib/format'

interface PageHeaderProps {
  title?: string
  subtitle?: string
  userName?: string | null
}

export function PageHeader({ title, subtitle, userName }: PageHeaderProps) {
  const greeting = getGreeting()

  return (
    <div className="relative overflow-hidden rounded-2xl bg-gradient-to-r from-brand-900 via-brand-800 to-brand-700 p-6 text-white shadow-elevated sm:p-8">
      <div className="absolute -right-10 -top-10 h-40 w-40 rounded-full bg-accent-500/15 blur-2xl" />
      <div className="absolute bottom-0 left-1/3 h-24 w-24 rounded-full bg-white/5 blur-xl" />
      <div className="relative">
        <p className="text-[11px] font-bold uppercase tracking-[0.22em] text-brand-200/80">
          {BRAND.name}
        </p>
        <h1 className="mt-2 font-display text-2xl font-bold sm:text-3xl">
          {title || `${greeting}${userName ? `, ${userName.split(' ')[0]}` : ''}`}
        </h1>
        <p className="mt-2 max-w-xl text-sm text-brand-100/90">
          {subtitle || `Operations overview · ${formatDate(new Date())}`}
        </p>
      </div>
    </div>
  )
}

function getGreeting() {
  const hour = new Date().getHours()
  if (hour < 12) return 'Good morning'
  if (hour < 17) return 'Good afternoon'
  return 'Good evening'
}
