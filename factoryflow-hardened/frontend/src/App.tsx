import { useEffect } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { useAuthStore } from '@/stores/authStore'
import { AppLayout } from '@/components/layout/AppLayout'
import { CustomerLayout } from '@/components/layout/CustomerLayout'
import { ProtectedRoute } from '@/routes/ProtectedRoute'
import { RoleRoute } from '@/routes/RoleRoute'
import { RoleGate } from '@/routes/RoleGate'
import { LoginPage } from '@/pages/LoginPage'
import { CustomerSignupPage } from '@/pages/customer/CustomerSignupPage'
import { CustomerPortalPage } from '@/pages/customer/CustomerPortalPage'
import { DashboardPage } from '@/pages/DashboardPage'
import { ProductionPage } from '@/pages/production/ProductionPage'
import { InventoryPage } from '@/pages/inventory/InventoryPage'
import { SalesPage } from '@/pages/sales/SalesPage'
import { HRPage } from '@/pages/hr/HRPage'
import { SettingsPage } from '@/pages/SettingsPage'

export default function App() {
  const initialize = useAuthStore((s) => s.initialize)

  useEffect(() => {
    initialize()
  }, [initialize])

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/customer/signup" element={<CustomerSignupPage />} />

        <Route
          element={
            <ProtectedRoute>
              <RoleGate allow={(role) => role !== 'customer'} redirectTo="/customer">
                <AppLayout />
              </RoleGate>
            </ProtectedRoute>
          }
        >
          <Route index element={<DashboardPage />} />
          <Route
            path="production"
            element={
              <RoleRoute module="production">
                <ProductionPage />
              </RoleRoute>
            }
          />
          <Route
            path="inventory"
            element={
              <RoleRoute module="inventory">
                <InventoryPage />
              </RoleRoute>
            }
          />
          <Route
            path="sales"
            element={
              <RoleRoute module="sales">
                <SalesPage />
              </RoleRoute>
            }
          />
          <Route
            path="hr"
            element={
              <RoleRoute module="hr">
                <HRPage />
              </RoleRoute>
            }
          />
          <Route
            path="settings"
            element={
              <RoleRoute module="settings">
                <SettingsPage />
              </RoleRoute>
            }
          />
        </Route>

        <Route
          path="/customer"
          element={
            <ProtectedRoute>
              <RoleGate allow={(role) => role === 'customer'} redirectTo="/">
                <CustomerLayout />
              </RoleGate>
            </ProtectedRoute>
          }
        >
          <Route index element={<CustomerPortalPage />} />
        </Route>

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  )
}
