import type { SVGProps } from 'react'

type IconProps = SVGProps<SVGSVGElement>

function IconBase({ children, ...props }: IconProps & { children: React.ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" {...props}>
      {children}
    </svg>
  )
}

export function DashboardIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <rect x="3" y="3" width="7" height="9" rx="1.5" />
      <rect x="14" y="3" width="7" height="5" rx="1.5" />
      <rect x="14" y="12" width="7" height="9" rx="1.5" />
      <rect x="3" y="16" width="7" height="5" rx="1.5" />
    </IconBase>
  )
}

export function ProductionIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M3 21h18" />
      <path d="M5 21V7l7-4 7 4v14" />
      <path d="M9 21v-6h6v6" />
      <path d="M9 9h.01M15 9h.01" />
    </IconBase>
  )
}

export function InventoryIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M21 8l-9-5-9 5v10l9 5 9-5V8z" />
      <path d="M3 8l9 5 9-5M12 13v10" />
    </IconBase>
  )
}

export function SalesIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M12 2v20M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6" />
    </IconBase>
  )
}

export function HRIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75" />
    </IconBase>
  )
}

export function SettingsIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
    </IconBase>
  )
}

export function LogoutIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9" />
    </IconBase>
  )
}
