import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { useAutoRefresh } from '@/hooks/useAutoRefresh'
import { useAuthStore } from '@/stores/authStore'
import { useToastStore } from '@/stores/toastStore'
import type { Employee, Attendance, PayrollRecord } from '@/types/database'
import { formatCurrency, formatDate, formatNumber } from '@/lib/format'
import { Card, StatCard } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { ResponsiveTable, TableRow } from '@/components/ui/Table'
import { LoadingSpinner } from '@/components/ui/LoadingSpinner'
import { PageTabs } from '@/components/ui/PageTabs'
import { EmployeeFormModal } from './EmployeeFormModal'
import { AttendanceFormModal } from './AttendanceFormModal'
import { PayrollFormModal } from './PayrollFormModal'

type Tab = 'employees' | 'attendance' | 'payroll'

export function HRPage() {
  const [tab, setTab] = useState<Tab>('employees')
  const [employees, setEmployees] = useState<Employee[]>([])
  const [attendance, setAttendance] = useState<Attendance[]>([])
  const [payroll, setPayroll] = useState<PayrollRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [showEmployeeForm, setShowEmployeeForm] = useState(false)
  const [showAttendanceForm, setShowAttendanceForm] = useState(false)
  const [showPayrollForm, setShowPayrollForm] = useState(false)

  const canManage = useAuthStore((s) => s.hasRole('admin', 'hr_officer'))
  const addToast = useToastStore((s) => s.addToast)
  const [fetchError,setFetchError]=useState<string|null>(null)
  const [clocking,setClocking]=useState(false)
  const isStaff=useAuthStore((st)=>st.hasRole('staff'))

  const fetchData = async (silent = false) => {
    if (!silent) setLoading(true)

    const [empRes, attRes, payRes] = await Promise.all([
      supabase.from('employees').select('*').order('full_name'),
      supabase
        .from('attendance')
        .select('*, employees(full_name)')
        .order('attendance_date', { ascending: false })
        .limit(50),
      supabase
        .from('payroll_records')
        .select('*, employees(full_name, role_title)')
        .order('period_year', { ascending: false })
        .order('period_month', { ascending: false }),
    ])

    const failure=[empRes,attRes,payRes].find(r=>r.error)
    if(failure?.error){setFetchError(failure.error.message);setLoading(false);return}
    setFetchError(null)
    setEmployees(empRes.data || [])
    setAttendance(attRes.data || [])
    setPayroll(payRes.data || [])
    if (!silent) setLoading(false)
  }

  useEffect(() => {
    fetchData()
  }, [])

  useAutoRefresh(() => fetchData(true), 60000)
  const staffClock=async(action:'in'|'out')=>{
    setClocking(true)
    const {error}=await supabase.rpc('staff_clock',{p_action:action})
    setClocking(false)
    if(error)addToast(error.message,'error')
    else {addToast(action==='in'?'Clocked in':'Clocked out');fetchData()}
  }
  const getHours=(a:Attendance)=> a.clock_in_at && a.clock_out_at
    ? Math.round((new Date(a.clock_out_at).getTime()-new Date(a.clock_in_at).getTime())/36000)/100
    : a.hours_worked
  const openShift=attendance.some(a=>a.clock_in_at && !a.clock_out_at)

  const activeEmployees = employees.filter((e) => e.is_active).length
  const today = new Date().toISOString().split('T')[0];

  const todayAttendance = attendance.filter(
    (a) => a.attendance_date === today
  ).length;

  const tabs = [
    { id: 'employees' as const, label: 'Employees' },
    { id: 'attendance' as const, label: 'Attendance' },
    { id: 'payroll' as const, label: 'Payroll' },
  ]

  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

  if (loading) return <LoadingSpinner className="py-20" />
  if(fetchError)return <Card title="HR unavailable"><p role="alert" className="text-red-700">{fetchError}</p>
    <Button onClick={()=>fetchData()}>Retry</Button></Card>

  return (
    <div className="page-shell space-y-6">
      {isStaff && <Card title="My Attendance">
        <p className="text-sm text-slate-600 mb-3">Clock-in/out is recorded with the server timestamp; overnight shifts are supported.</p>
        <div className="flex gap-2">
          <Button onClick={()=>staffClock('in')} loading={clocking} disabled={openShift}>Clock In</Button>
          <Button onClick={()=>staffClock('out')} loading={clocking} disabled={!openShift}>Clock Out</Button>
        </div>
      </Card>}
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
        <StatCard label="Active Employees" value={activeEmployees} />
        <StatCard label="Today's Attendance" value={todayAttendance} />
        <StatCard label="Payroll Records" value={payroll.length} />
      </div>

      <PageTabs
        tabs={tabs}
        active={tab}
        onChange={(id) => setTab(id as Tab)}
        action={
          canManage && tab === 'employees' ? (
            <Button variant="secondary" onClick={() => setShowEmployeeForm(true)}>
              + Add Employee
            </Button>
          ) : canManage && tab === 'attendance' ? (
            <Button variant="secondary" onClick={() => setShowAttendanceForm(true)}>
              + Log Attendance
            </Button>
          ) : canManage && tab === 'payroll' ? (
            <Button variant="secondary" onClick={() => setShowPayrollForm(true)}>
              + Generate Payroll
            </Button>
          ) : undefined
        }
      />

      {tab === 'employees' && (
        <Card title="Employee Records">
          <ResponsiveTable
            headers={['Name', 'Role', 'Hire Date', 'Rate', 'Phone', 'Status']}
            isEmpty={employees.length === 0}
          >
            {employees.map((e) => (
              <TableRow
                key={e.id}
                cells={[
                  e.full_name,
                  e.role_title,
                  formatDate(e.hire_date),
                  e.rate_type === 'monthly'
                    ? formatCurrency(e.salary_rate || 0) + '/mo'
                    : formatCurrency(e.wage_rate || 0) + `/${e.rate_type}`,
                  e.contact_phone || '—',
                  e.is_active ? 'Active' : 'Inactive',
                ]}
                mobileCard={
                  <div className="space-y-1 text-sm">
                    <p className="font-medium">{e.full_name}</p>
                    <p className="text-xs text-slate-500">{e.role_title}</p>
                    <p className="text-xs">Hired: {formatDate(e.hire_date)}</p>
                  </div>
                }
              />
            ))}
          </ResponsiveTable>
        </Card>
      )}

      {tab === 'attendance' && (
        <Card title="Attendance Log">
          <ResponsiveTable
            headers={['Date', 'Employee', 'Clock In', 'Clock Out', 'Hours']}
            isEmpty={attendance.length === 0}
          >
            {attendance.map((a) => (
              <TableRow
                key={a.id}
                cells={[
                  formatDate(a.attendance_date),
                  (a.employees as Employee)?.full_name || '—',
                  a.clock_in || '—',
                  a.clock_out || '—',
                  getHours(a) != null ? formatNumber(getHours(a)!, 1) : '—',
                ]}
                mobileCard={
                  <div className="space-y-1 text-sm">
                    <div className="flex justify-between">
                      <span className="font-medium">{(a.employees as Employee)?.full_name}</span>
                      <span>{formatDate(a.attendance_date)}</span>
                    </div>
                    <p className="text-xs">{a.clock_in} — {a.clock_out || 'Not out'}</p>
                  </div>
                }
              />
            ))}
          </ResponsiveTable>
        </Card>
      )}

      {tab === 'payroll' && (
        <Card title="Payroll Records">
          <ResponsiveTable
            headers={['Period', 'Employee', 'Days/Hours', 'Gross', 'Deductions', 'Net Pay']}
            isEmpty={payroll.length === 0}
          >
            {payroll.map((p) => (
              <TableRow
                key={p.id}
                cells={[
                  `${monthNames[p.period_month - 1]} ${p.period_year}`,
                  (p.employees as Employee)?.full_name || '—',
                  `${p.days_worked}d / ${formatNumber(p.hours_worked, 1)}h`,
                  formatCurrency(p.gross_pay),
                  formatCurrency(p.deductions),
                  formatCurrency(p.net_pay),
                ]}
                mobileCard={
                  <div className="space-y-1 text-sm">
                    <div className="flex justify-between">
                      <span className="font-medium">{(p.employees as Employee)?.full_name}</span>
                      <span className="font-medium">{formatCurrency(p.net_pay)}</span>
                    </div>
                    <p className="text-xs text-slate-500">
                      {monthNames[p.period_month - 1]} {p.period_year}
                    </p>
                  </div>
                }
              />
            ))}
          </ResponsiveTable>
        </Card>
      )}

      {showEmployeeForm && (
        <EmployeeFormModal
          onClose={() => setShowEmployeeForm(false)}
          onSuccess={() => {
            setShowEmployeeForm(false)
            fetchData()
            addToast('Employee added')
          }}
        />
      )}

      {showAttendanceForm && (
        <AttendanceFormModal
          employees={employees.filter((e) => e.is_active)}
          onClose={() => setShowAttendanceForm(false)}
          onSuccess={() => {
            setShowAttendanceForm(false)
            fetchData()
            addToast('Attendance logged')
          }}
        />
      )}

      {showPayrollForm && (
        <PayrollFormModal
          employees={employees.filter((e) => e.is_active)}
          onClose={() => setShowPayrollForm(false)}
          onSuccess={() => {
            setShowPayrollForm(false)
            fetchData()
            addToast('Payroll record created')
          }}
        />
      )}
    </div>
  )
}
