import { useState } from 'react'
import { supabase } from '@/lib/supabase'
import { useToastStore } from '@/stores/toastStore'
import { Modal } from '@/components/ui/Modal'
import { Input } from '@/components/ui/Input'
import { Button } from '@/components/ui/Button'

interface CustomerFormModalProps {
  onClose: () => void
  onSuccess: () => void
}

export function CustomerFormModal({ onClose, onSuccess }: CustomerFormModalProps) {
  const addToast = useToastStore((s) => s.addToast)
  const [loading, setLoading] = useState(false)
  const [form, setForm] = useState({
    name: '',
    business_name: '',
    contact_phone: '',
    contact_email: '',
    address: '',
    credit_terms_days: '0',
  })

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)

    const { error } = await supabase.from('customers').insert({
      name: form.name,
      business_name: form.business_name || null,
      contact_phone: form.contact_phone || null,
      contact_email: form.contact_email || null,
      address: form.address || null,
      credit_terms_days: parseInt(form.credit_terms_days) || 0,
    })

    setLoading(false)
    if (error) addToast(error.message, 'error')
    else onSuccess()
  }

  return (
    <Modal open title="Add Customer" onClose={onClose}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <Input label="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
        <Input label="Business Name" value={form.business_name} onChange={(e) => setForm({ ...form, business_name: e.target.value })} />
        <Input label="Phone" value={form.contact_phone} onChange={(e) => setForm({ ...form, contact_phone: e.target.value })} />
        <Input label="Email" type="email" value={form.contact_email} onChange={(e) => setForm({ ...form, contact_email: e.target.value })} />
        <Input label="Address" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
        <Input label="Credit Terms (days)" type="number" value={form.credit_terms_days} onChange={(e) => setForm({ ...form, credit_terms_days: e.target.value })} />
        <div className="flex gap-3 justify-end">
          <Button variant="secondary" type="button" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={loading}>Save</Button>
        </div>
      </form>
    </Modal>
  )
}
