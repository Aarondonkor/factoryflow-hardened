import { useState } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { useToastStore } from '@/stores/toastStore'
import type { Machine } from '@/types/database'
import { Modal } from '@/components/ui/Modal'
import { Select } from '@/components/ui/Select'
import { Input } from '@/components/ui/Input'
import { Button } from '@/components/ui/Button'

interface DowntimeFormProps {
  machines: Machine[]
  onClose: () => void
  onSuccess: () => void
}

export function DowntimeForm({ machines, onClose, onSuccess }: DowntimeFormProps) {
  const user = useAuthStore((s) => s.user)
  const addToast = useToastStore((s) => s.addToast)
  const [loading, setLoading] = useState(false)

  const now = new Date()
  const defaultStart = now.toISOString().slice(0, 16)

  const [form, setForm] = useState({
    machine_id: machines[0]?.id || '',
    reason: 'maintenance' as 'maintenance' | 'power_outage' | 'breakdown' | 'other',
    reason_detail: '',
    start_time: defaultStart,
    end_time: '',
  })

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)

    const { error } = await supabase.from('machine_downtime').insert({
      machine_id: form.machine_id,
      reason: form.reason,
      reason_detail: form.reason_detail || null,
      start_time: new Date(form.start_time).toISOString(),
      end_time: form.end_time ? new Date(form.end_time).toISOString() : null,
      created_by: user?.id,
    })

    setLoading(false)

    if (error) addToast(error.message, 'error')
    else onSuccess()
  }

  return (
    <Modal open title="Log Machine Downtime" onClose={onClose}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <Select
          label="Machine"
          value={form.machine_id}
          onChange={(e) => setForm({ ...form, machine_id: e.target.value })}
          required
        >
          {machines.map((m) => (
            <option key={m.id} value={m.id}>{m.machine_code} — {m.name}</option>
          ))}
        </Select>

        <Select
          label="Reason"
          value={form.reason}
          onChange={(e) => setForm({ ...form, reason: e.target.value as typeof form.reason })}
        >
          <option value="maintenance">Maintenance</option>
          <option value="power_outage">Power Outage</option>
          <option value="breakdown">Breakdown</option>
          <option value="other">Other</option>
        </Select>

        <Input
          label="Details"
          value={form.reason_detail}
          onChange={(e) => setForm({ ...form, reason_detail: e.target.value })}
        />

        <div className="grid grid-cols-2 gap-4">
          <Input
            label="Start Time"
            type="datetime-local"
            value={form.start_time}
            onChange={(e) => setForm({ ...form, start_time: e.target.value })}
            required
          />
          <Input
            label="End Time (optional)"
            type="datetime-local"
            value={form.end_time}
            onChange={(e) => setForm({ ...form, end_time: e.target.value })}
          />
        </div>

        <div className="flex gap-3 justify-end pt-2">
          <Button variant="secondary" type="button" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={loading}>Save Downtime</Button>
        </div>
      </form>
    </Modal>
  )
}
