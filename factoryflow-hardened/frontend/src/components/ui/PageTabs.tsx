import type { ReactNode } from 'react'

interface PageTabsProps {
  tabs: { id: string; label: string }[]
  active: string
  onChange: (id: string) => void
  action?: ReactNode
}

export function PageTabs({ tabs, active, onChange, action }: PageTabsProps) {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-slate-200/80 bg-white p-1.5 shadow-sm">
      {tabs.map((t) => (
        <button
          key={t.id}
          onClick={() => onChange(t.id)}
          className={`rounded-xl px-4 py-2.5 text-sm font-semibold transition-all duration-200 ${
            active === t.id
              ? 'bg-brand-700 text-white shadow-sm'
              : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'
          }`}
        >
          {t.label}
        </button>
      ))}
      {action && <div className="ml-auto flex gap-2 pr-1">{action}</div>}
    </div>
  )
}
