import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import type { ProductRoll } from '@/types/database'
import { useToastStore } from '@/stores/toastStore'
import type { Customer, FinishedGood } from '@/types/database'
import { toInputDate } from '@/lib/format'
import { Modal } from '@/components/ui/Modal'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Button } from '@/components/ui/Button'

interface OrderFormModalProps {
  customers: Customer[]
  finishedGoods: FinishedGood[]
  onClose: () => void
  onSuccess: () => void
}

export function OrderFormModal({ customers, finishedGoods, onClose, onSuccess }: OrderFormModalProps) {
  const addToast = useToastStore((s) => s.addToast)
  const [loading, setLoading] = useState(false)
  const [rolls, setRolls] = useState<ProductRoll[]>([])
  const [selectedRollIds, setSelectedRollIds] = useState<string[]>([])

  const [form, setForm] = useState({
    customer_id: customers[0]?.id || '',
    delivery_date: toInputDate(new Date(Date.now() + 7 * 86400000)),
    notes: '',
    finished_good_id: finishedGoods[0]?.id || '',
    quantity: '',
    unit_price: '',
  })

  useEffect(() => {
    supabase.from('product_rolls').select('*').eq('status','available').order('roll_no').limit(500)
      .then(({data,error}) => { if (!error) setRolls(data || []) })
  }, [])

  const selectedProduct = finishedGoods.find((g) => g.id === form.finished_good_id)
  const isRoll = selectedProduct?.unit === 'rolls'

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const qty = Number(form.quantity)
    const price = Number(form.unit_price)
    if (isRoll ? selectedRollIds.length === 0 : (!Number.isFinite(qty) || qty<=0 || !Number.isFinite(price) || price<0)) {
      addToast(isRoll ? 'Select one or more available physical rolls' : 'Enter valid quantity and price', 'error')
      return
    }
    setLoading(true)
    const { error } = await supabase.rpc('create_staff_order', {
      p_customer: form.customer_id,
      p_delivery_date: form.delivery_date || null,
      p_notes: form.notes || null,
      p_items: isRoll ? [] : [{ finished_good_id: form.finished_good_id, quantity: qty,
        unit_price: price, specified_micron: null }],
      p_roll_ids: isRoll ? selectedRollIds : [],
    })
    setLoading(false)
    if (error) addToast(error.message,'error')
    else onSuccess()
  }

  return (
    <Modal open title="Create Order" onClose={onClose} size="lg">
      <form onSubmit={handleSubmit} className="space-y-4">
        <Select
          label="Customer"
          value={form.customer_id}
          onChange={(e) => setForm({ ...form, customer_id: e.target.value })}
          required
        >
          {customers.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </Select>

        <Input
          label="Delivery Date"
          type="date"
          value={form.delivery_date}
          onChange={(e) => setForm({ ...form, delivery_date: e.target.value })}
        />

        <div className="border-t pt-4">
          <p className="text-sm font-medium mb-3">Order Item</p>
          <Select
            label="Product"
            value={form.finished_good_id}
            onChange={(e) => {setForm({ ...form, finished_good_id: e.target.value });setSelectedRollIds([])}}
            required
          >
            {finishedGoods.map((g) => (
              <option key={g.id} value={g.id}>
                {g.product_name} ({g.current_stock} {g.unit} in stock)
              </option>
            ))}
          </Select>
          {!isRoll && <div className="grid grid-cols-2 gap-4 mt-4">
            <Input
              label="Quantity"
              type="number"
              step="0.01"
              value={form.quantity}
              onChange={(e) => setForm({ ...form, quantity: e.target.value })}
              required
            />
            <Input
              label="Unit Price (GHS)"
              type="number"
              step="0.01"
              value={form.unit_price}
              onChange={(e) => setForm({ ...form, unit_price: e.target.value })}
              required
            />
          </div>}
          {isRoll && (
            <div className="mt-4 space-y-2">
              <p className="text-sm font-medium">Select physical rolls (priced by their measured kg weight)</p>
              <div className="max-h-52 overflow-auto space-y-2 rounded-lg border p-3">
                {rolls.filter(r => r.finished_good_id===form.finished_good_id).map(r => (
                  <label key={r.id} className="flex gap-2 items-center text-sm">
                    <input type="checkbox" checked={selectedRollIds.includes(r.id)}
                      onChange={() => setSelectedRollIds(current => current.includes(r.id) ? current.filter(id=>id!==r.id) : [...current,r.id])} />
                    Roll #{r.roll_no}: {r.weight_kg} kg · {r.micron || '—'}µ
                  </label>
                ))}
                {rolls.filter(r=>r.finished_good_id===form.finished_good_id).length===0 &&
                  <p className="text-xs text-amber-700">No available physical rolls. Reconcile individual roll stock first.</p>}
              </div>
            </div>
          )}
        </div>

        <Input label="Notes" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />

        <div className="flex gap-3 justify-end">
          <Button variant="secondary" type="button" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={loading}>Create Order</Button>
        </div>
      </form>
    </Modal>
  )
}
