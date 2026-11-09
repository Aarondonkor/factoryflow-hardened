import { useState } from 'react'
import { supabase } from '@/lib/supabase'
import { useToastStore } from '@/stores/toastStore'
import type { Employee } from '@/types/database'
import { Modal } from '@/components/ui/Modal'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Button } from '@/components/ui/Button'

interface Props { employees: Employee[]; onClose: () => void; onSuccess: () => void }

/** Payroll is calculated in the database from timestamped attendance and employee rates. */
export function PayrollFormModal({employees,onClose,onSuccess}: Props) {
  const addToast=useToastStore(s=>s.addToast)
  const now=new Date()
  const [loading,setLoading]=useState(false)
  const [form,setForm]=useState({employee_id:employees[0]?.id||'',month:String(now.getMonth()+1),
    year:String(now.getFullYear()),deductions:'0',notes:''})
  const submit=async(e:React.FormEvent)=>{
    e.preventDefault()
    setLoading(true)
    const {error}=await supabase.rpc('generate_payroll',{
      p_employee:form.employee_id,p_month:Number(form.month),p_year:Number(form.year),
      p_deductions:Number(form.deductions),p_notes:form.notes,
    })
    setLoading(false)
    if(error)addToast(error.message,'error')
    else onSuccess()
  }
  return <Modal open title="Generate Attendance-Based Payroll" size="lg" onClose={onClose}>
    <form onSubmit={submit} className="space-y-4">
      <p className="text-sm text-slate-600">Days, hours and gross pay are calculated from completed attendance records and the employee's approved rate. They cannot be overridden from the browser.</p>
      <Select label="Employee" value={form.employee_id} onChange={e=>setForm({...form,employee_id:e.target.value})}>
        {employees.map(e=><option key={e.id} value={e.id}>{e.full_name} · {e.rate_type}</option>)}
      </Select>
      <div className="grid grid-cols-2 gap-3">
        <Select label="Month" value={form.month} onChange={e=>setForm({...form,month:e.target.value})}>
          {Array.from({length:12},(_,i)=><option value={i+1} key={i+1}>{new Date(2000,i).toLocaleString('en',{month:'long'})}</option>)}
        </Select>
        <Input label="Year" type="number" min="2000" max="2100" value={form.year} onChange={e=>setForm({...form,year:e.target.value})}/>
      </div>
      <Input label="Approved Deductions (GHS)" type="number" min="0" step="0.01" value={form.deductions}
        onChange={e=>setForm({...form,deductions:e.target.value})}/>
      <Input label="Notes" value={form.notes} onChange={e=>setForm({...form,notes:e.target.value})}/>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
        <Button type="submit" loading={loading}>Calculate and Save</Button>
      </div>
    </form>
  </Modal>
}
