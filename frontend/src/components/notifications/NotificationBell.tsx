import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { formatDateTime } from '@/lib/format'
import type { Notification } from '@/types/database'

export function NotificationBell() {
  const user = useAuthStore((s) => s.user)
  const [notifications, setNotifications] = useState<Notification[]>([])
  const [open, setOpen] = useState(false)

  const unreadCount = notifications.filter((n) => !n.is_read).length

  useEffect(() => {
    if (!user) return

    const fetchNotifications = async () => {
      const { data } = await supabase
        .from('notifications')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(30)
      setNotifications(data || [])
    }

    fetchNotifications()

    const channel = supabase
      .channel(`notifications-${user.id}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'notifications', filter: `profile_id=eq.${user.id}` },
        (payload) => {
          setNotifications((prev) => [payload.new as Notification, ...prev])
        }
      )
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [user])

  const markAllRead = async () => {
    const unreadIds = notifications.filter((n) => !n.is_read).map((n) => n.id)
    if (unreadIds.length === 0) return

    setNotifications((prev) => prev.map((n) => ({ ...n, is_read: true })))
    await supabase.from('notifications').update({ is_read: true }).in('id', unreadIds)
  }

  const handleToggle = () => {
    setOpen((o) => {
      const next = !o
      if (next) markAllRead()
      return next
    })
  }

  return (
    <div className="relative">
      <button
        onClick={handleToggle}
        className="relative rounded-xl border border-slate-200 p-2.5 text-slate-600 transition-colors hover:bg-slate-50"
        aria-label="Notifications"
      >
        <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M15 17h5l-1.4-1.4A2 2 0 0118 14.2V11a6 6 0 10-12 0v3.2a2 2 0 01-.6 1.4L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"
          />
        </svg>
        {unreadCount > 0 && (
          <span className="absolute -top-1 -right-1 flex h-5 w-5 items-center justify-center rounded-full bg-accent-500 text-[10px] font-bold text-brand-950">
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-50 mt-2 w-80 max-h-96 overflow-y-auto rounded-2xl border border-slate-200 bg-white shadow-elevated">
            <div className="border-b border-slate-100 px-4 py-3">
              <p className="font-display text-sm font-bold text-slate-900">Notifications</p>
            </div>
            {notifications.length === 0 ? (
              <p className="px-4 py-8 text-center text-sm text-slate-400">No notifications yet</p>
            ) : (
              <div className="divide-y divide-slate-100">
                {notifications.map((n) => (
                  <div key={n.id} className={`px-4 py-3 ${!n.is_read ? 'bg-brand-50/50' : ''}`}>
                    <p className="text-sm font-semibold text-slate-800">{n.title}</p>
                    <p className="mt-0.5 text-xs text-slate-500">{n.message}</p>
                    <p className="mt-1 text-[11px] text-slate-400">{formatDateTime(n.created_at)}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}
