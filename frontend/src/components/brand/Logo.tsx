import { BRAND } from '@/lib/brand'

interface LogoProps {
  variant?: 'light' | 'dark'
  size?: 'sm' | 'md' | 'lg'
}

function LogoMark({ size }: { size: 'sm' | 'md' | 'lg' }) {
  const box = { sm: 'h-8 w-8', md: 'h-10 w-10', lg: 'h-14 w-14' }[size]
  const text = { sm: 'text-sm', md: 'text-lg', lg: 'text-2xl' }[size]

  return (
    <div className={`${box} rounded-xl bg-gradient-to-br from-brand-600 to-brand-800 flex items-center justify-center shadow-lg ring-2 ring-accent-500/30`}>
      <span className={`font-display font-extrabold text-white leading-none ${text}`}>P</span>
    </div>
  )
}

export function Logo({ variant = 'dark', size = 'md' }: LogoProps) {
  const title = { sm: 'text-sm', md: 'text-base', lg: 'text-2xl' }[size]
  const tag = { sm: 'text-[10px]', md: 'text-xs', lg: 'text-sm' }[size]
  const isLight = variant === 'light'

  return (
    <div className="flex items-center gap-3">
      <LogoMark size={size} />
      <div className="min-w-0">
        <p className={`font-display font-bold tracking-tight leading-tight ${title} ${isLight ? 'text-white' : 'text-brand-950'}`}>
          {BRAND.shortName}
        </p>
        <p className={`font-semibold uppercase tracking-[0.18em] ${tag} ${isLight ? 'text-brand-200' : 'text-brand-600'}`}>
          Ventures
        </p>
      </div>
    </div>
  )
}
