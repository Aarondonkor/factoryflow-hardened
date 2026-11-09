import { useToastStore } from '@/stores/toastStore'
import type { ToastType } from '@/stores/toastStore'

const icons: Record<ToastType, string> = {
  success: '✓',
  error: '✕',
  warning: '!',
  info: 'i',
}

const colors: Record<ToastType, string> = {
  success: 'bg-brand-800',
  error: 'bg-red-700',
  warning: 'bg-amber-600',
  info: 'bg-brand-600',
}

export function ToastContainer() {
  const toasts = useToastStore((s) => s.toasts)
  const removeToast = useToastStore((s) => s.removeToast)

  return (
    <div className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`flex items-center gap-3 rounded-lg px-4 py-3 text-white shadow-lg ${colors[toast.type]} min-w-[280px]`}
        >
          <span className="font-bold">{icons[toast.type]}</span>
          <span className="flex-1 text-sm">{toast.message}</span>
          <button
            onClick={() => removeToast(toast.id)}
            className="text-white/80 hover:text-white"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  )
}
