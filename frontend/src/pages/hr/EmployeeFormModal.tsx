import { useState } from 'react'
import { supabase } from '@/lib/supabase'
import { useToastStore } from '@/stores/toastStore'
import { toInputDate } from '@/lib/format'
import { Modal } from '@/components/ui/Modal'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Button } from '@/components/ui/Button'

interface EmployeeFormModalProps {
  onClose: () => void
  onSuccess: () => void
}

export function EmployeeFormModal({ onClose, onSuccess }: EmployeeFormModalProps) {
  const addToast = useToastStore((s) => s.addToast)
  const [loading, setLoading] = useState(false)
  const [form, setForm] = useState({
    full_name: '',
    role_title: '',
    contact_phone: '',
    contact_email: '',
    hire_date: toInputDate(),
    rate_type: 'monthly' as 'monthly' | 'hourly' | 'daily',
    salary_rate: '',
    wage_rate: '',
    ghana_card_number: '',
    next_of_kin_name: '',
    next_of_kin_phone: '',
  })

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)

    const { error } = await supabase.from('employees').insert({
      full_name: form.full_name,
      role_title: form.role_title,
      contact_phone: form.contact_phone || null,
      contact_email: form.contact_email || null,
      hire_date: form.hire_date,
      rate_type: form.rate_type,
      salary_rate: form.rate_type === 'monthly' ? parseFloat(form.salary_rate) || null : null,
      wage_rate: form.rate_type !== 'monthly' ? parseFloat(form.wage_rate) || null : null,
      ghana_card_number: form.ghana_card_number || null,
      next_of_kin_name: form.next_of_kin_name || null,
      next_of_kin_phone: form.next_of_kin_phone || null,
    })

    setLoading(false)
    if (error) addToast(error.message, 'error')
    else onSuccess()
  }

  return (
    <Modal open title="Add Employee" onClose={onClose} size="lg">
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <Input label="Full Name" value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} required />
          <Input label="Role / Title" value={form.role_title} onChange={(e) => setForm({ ...form, role_title: e.target.value })} required />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <Input label="Phone" value={form.contact_phone} onChange={(e) => setForm({ ...form, contact_phone: e.target.value })} />
          <Input label="Email" type="email" value={form.contact_email} onChange={(e) => setForm({ ...form, contact_email: e.target.value })} />
        </div>
        <Input label="Hire Date" type="date" value={form.hire_date} onChange={(e) => setForm({ ...form, hire_date: e.target.value })} required />
        <Select label="Rate Type" value={form.rate_type} onChange={(e) => setForm({ ...form, rate_type: e.target.value as typeof form.rate_type })}>
          <option value="monthly">Monthly Salary</option>
          <option value="hourly">Hourly Wage</option>
          <option value="daily">Daily Wage</option>
        </Select>
        {form.rate_type === 'monthly' ? (
          <Input label="Monthly Salary (GHS)" type="number" value={form.salary_rate} onChange={(e) => setForm({ ...form, salary_rate: e.target.value })} />
        ) : (
          <Input label={`${form.rate_type} Rate (GHS)`} type="number" value={form.wage_rate} onChange={(e) => setForm({ ...form, wage_rate: e.target.value })} />
        )}
        <Input label="Ghana Card Number" value={form.ghana_card_number} onChange={(e) => setForm({ ...form, ghana_card_number: e.target.value })} />
        <div className="grid grid-cols-2 gap-4">
          <Input label="Next of Kin Name" value={form.next_of_kin_name} onChange={(e) => setForm({ ...form, next_of_kin_name: e.target.value })} />
          <Input label="Next of Kin Phone" value={form.next_of_kin_phone} onChange={(e) => setForm({ ...form, next_of_kin_phone: e.target.value })} />
        </div>
        <div className="flex gap-3 justify-end">
          <Button variant="secondary" type="button" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={loading}>Save</Button>
        </div>
      </form>
    </Modal>
  )
}
