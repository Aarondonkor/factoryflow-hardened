import { useState } from 'react'
import { supabase } from '@/lib/supabase'
import { useToastStore } from '@/stores/toastStore'
import type { Employee } from '@/types/database'
import { toInputDate } from '@/lib/format'
import { Modal } from '@/components/ui/Modal'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Button } from '@/components/ui/Button'

interface Props {employees:Employee[],onClose:()=>void,onSuccess:()=>void}
export function AttendanceFormModal({employees,onClose,onSuccess}:Props) {
  const addToast=useToastStore(s=>s.addToast)
  const [loading,setLoading]=useState(false)
  const [form,setForm]=useState({employee_id:employees[0]?.id||'',date:toInputDate(),clock_in:'08:00',clock_out:'17:00',notes:''})
  const submit=async(e:React.FormEvent)=>{
    e.preventDefault()
    setLoading(true)
    const {error}=await supabase.rpc('hr_log_attendance',{
      p_employee:form.employee_id,p_date:form.date,p_in:form.clock_in,p_out:form.clock_out || null,p_notes:form.notes,
    })
    setLoading(false)
    if(error)addToast(error.message,'error')
    else onSuccess()
  }
  return <Modal open title="HR Attendance Correction" onClose={onClose}>
    <form onSubmit={submit} className="space-y-4">
      <p className="text-xs text-slate-500">Times are Ghana local time (GMT). If clock-out is earlier than clock-in, the shift is treated as crossing midnight. HR corrections should include a reason.</p>
      <Select label="Employee" value={form.employee_id} onChange={e=>setForm({...form,employee_id:e.target.value})}>
        {employees.map(e=><option key={e.id} value={e.id}>{e.full_name}</option>)}
      </Select>
      <Input label="Date" type="date" value={form.date} onChange={e=>setForm({...form,date:e.target.value})} required/>
      <div className="grid grid-cols-2 gap-3">
        <Input label="Clock In" type="time" value={form.clock_in} onChange={e=>setForm({...form,clock_in:e.target.value})} required/>
        <Input label="Clock Out" type="time" value={form.clock_out} onChange={e=>setForm({...form,clock_out:e.target.value})}/>
      </div>
      <Input label="Reason / Notes" value={form.notes} onChange={e=>setForm({...form,notes:e.target.value})} required/>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
        <Button type="submit" loading={loading}>Save Attendance</Button>
      </div>
    </form>
  </Modal>
}
