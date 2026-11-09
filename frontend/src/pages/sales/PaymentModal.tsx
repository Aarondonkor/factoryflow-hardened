import { useState } from 'react'
import { supabase } from '@/lib/supabase'
import { useToastStore } from '@/stores/toastStore'
import type { Order } from '@/types/database'
import { formatCurrency } from '@/lib/format'
import { startVerifiedCheckout } from '@/lib/paystack'
import { Modal } from '@/components/ui/Modal'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Button } from '@/components/ui/Button'

interface PaymentModalProps {
  order: Order
  onClose: () => void
  onSuccess: () => void
}

export function PaymentModal({ order, onClose, onSuccess }: PaymentModalProps) {
  const addToast = useToastStore((s) => s.addToast)
  const [loading, setLoading] = useState(false)
  const [form, setForm] = useState({
    amount: order.balance_due.toString(),
    payment_method: 'cash' as 'paystack' | 'cash' | 'mobile_money' | 'bank_transfer',
    notes: '',
  })

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const amount = Number(form.amount)
    if (!Number.isFinite(amount) || amount <= 0 || amount > order.balance_due) {
      addToast('Enter an amount no greater than the outstanding balance', 'error')
      return
    }
    setLoading(true)
    try {
      if (form.payment_method === 'paystack') {
        await startVerifiedCheckout(order.id, amount)
        return
      }
      const { error } = await supabase.rpc('record_offline_payment', {
        p_order: order.id, p_amount: amount, p_method: form.payment_method, p_notes: form.notes,
      })
      if (error) throw error
      onSuccess()
    } catch (err) {
      addToast(err instanceof Error ? err.message : 'Payment failed', 'error')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Modal open title={`Record Payment — ${order.order_number}`} onClose={onClose}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="rounded-lg bg-slate-50 p-4 text-sm">
          <div className="flex justify-between">
            <span>Order Total</span>
            <span className="font-medium">{formatCurrency(order.total)}</span>
          </div>
          <div className="flex justify-between mt-1">
            <span>Balance Due</span>
            <span className="font-medium text-red-600">{formatCurrency(order.balance_due)}</span>
          </div>
        </div>

        <Input
          label="Amount (GHS)"
          type="number"
          step="0.01"
          value={form.amount}
          onChange={(e) => setForm({ ...form, amount: e.target.value })}
          required
        />

        <Select
          label="Payment Method"
          value={form.payment_method}
          onChange={(e) => setForm({ ...form, payment_method: e.target.value as typeof form.payment_method })}
        >
          <option value="cash">Cash</option>
          <option value="mobile_money">Mobile Money</option>
          <option value="bank_transfer">Bank Transfer</option>
          <option value="paystack">Paystack (Online)</option>
        </Select>

        <Input label="Notes" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />

        <div className="flex gap-3 justify-end">
          <Button variant="secondary" type="button" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={loading}>
            {form.payment_method === 'paystack' ? 'Pay with Paystack' : 'Record Payment'}
          </Button>
        </div>
      </form>
    </Modal>
  )
}
