import { useEffect, useRef } from 'react'

/**
 * Keeps a page's data current without the user having to manually reload:
 * - refetches on an interval while the tab is visible
 * - refetches immediately when the tab regains focus/visibility
 *
 * Pass the same fetch function you already call on mount; this hook does not
 * call it on mount itself, so keep your existing `useEffect(() => { fetchData() }, [])`
 * alongside it.
 */
export function useAutoRefresh(fetchFn: () => void | Promise<void>, intervalMs = 30000) {
  const fetchRef = useRef(fetchFn)
  fetchRef.current = fetchFn

  const busyRef = useRef(false)
  const lastStartRef = useRef(0)
  useEffect(() => {
    const safeRefresh = () => {
      const now = Date.now()
      if (document.visibilityState !== 'visible' || busyRef.current || now - lastStartRef.current < 1500) return
      busyRef.current = true
      lastStartRef.current = now
      Promise.resolve().then(() => fetchRef.current()).catch(console.error).finally(() => { busyRef.current = false })
    }
    const interval = setInterval(() => {
      safeRefresh()
    }, intervalMs)

    const handleVisibility = () => {
      safeRefresh()
    }
    const handleFocus = () => {
      safeRefresh()
    }

    document.addEventListener('visibilitychange', handleVisibility)
    window.addEventListener('focus', handleFocus)

    return () => {
      clearInterval(interval)
      document.removeEventListener('visibilitychange', handleVisibility)
      window.removeEventListener('focus', handleFocus)
    }
  }, [intervalMs])
}
