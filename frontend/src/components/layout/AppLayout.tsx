import { useState } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import { Sidebar } from './Sidebar'
import { Header } from './Header'
import { ToastContainer } from '@/components/ui/Toast'
import { BRAND } from '@/lib/brand'

const pageTitles: Record<string, string> = {
  '/': 'Dashboard',
  '/production': 'Production',
  '/inventory': 'Inventory',
  '/sales': 'Sales & Orders',
  '/hr': 'Human Resources',
  '/settings': 'Settings',
}

export function AppLayout() {
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const location = useLocation()
  const title = pageTitles[location.pathname] || BRAND.appName

  return (
    <div className="flex min-h-screen bg-[#f4f6f5]">
      <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />
      <div className="flex min-w-0 flex-1 flex-col">
        <Header title={title} onMenuClick={() => setSidebarOpen(true)} />
        <main className="flex-1 overflow-auto p-4 lg:p-8">
          <div className="mx-auto max-w-7xl">
            <Outlet />
          </div>
        </main>
      </div>
      <ToastContainer />
    </div>
  )
}
