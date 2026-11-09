import type { SelectHTMLAttributes, ReactNode } from 'react'

interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: string
  error?: string
  children: ReactNode
}

export function Select({ label, error, children, className = '', id, ...props }: SelectProps) {
  const selectId = id || props.name
  return (
    <div className={className}>
      {label && (
        <label htmlFor={selectId} className="label">
          {label}
        </label>
      )}
      <select id={selectId} className={`input ${error ? 'border-red-500' : ''}`} {...props}>
        {children}
      </select>
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </div>
  )
}
