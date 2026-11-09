import { useState } from 'react'
import { supabase } from '@/lib/supabase'
import { useToastStore } from '@/stores/toastStore'
import { Modal } from '@/components/ui/Modal'
import { Select } from '@/components/ui/Select'
import { Input } from '@/components/ui/Input'
import { Button } from '@/components/ui/Button'

interface StockAdjustModalProps {
  materialType: 'raw' | 'finished'
  materialId: string
  materialName: string
  onClose: () => void
  onSuccess: () => void
}

export function StockAdjustModal({
  materialType,
  materialId,
  materialName,
  onClose,
  onSuccess,
}: StockAdjustModalProps) {
  const [movementType, setMovementType] = useState<'in' | 'out'>('in')
  const [quantity, setQuantity] = useState('')
  const [reason, setReason] = useState('')
  const [loading, setLoading] = useState(false)
  const addToast = useToastStore((s) => s.addToast)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const qty = parseFloat(quantity)
    if (!qty || qty <= 0) {
      addToast('Enter a valid quantity', 'error')
      return
    }

    setLoading(true)
    const { error } = await supabase.rpc('adjust_stock', {
      p_material_type: materialType,
      p_material_id: materialId,
      p_quantity: qty,
      p_movement_type: movementType,
      p_reason: reason || 'Manual adjustment',
    })
    setLoading(false)

    if (error) {
      addToast(error.message, 'error')
    } else {
      onSuccess()
    }
  }

  return (
    <Modal open title={`Adjust Stock — ${materialName}`} onClose={onClose}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <Select
          label="Movement Type"
          value={movementType}
          onChange={(e) => setMovementType(e.target.value as 'in' | 'out')}
        >
          <option value="in">Stock In (Restock / Add)</option>
          <option value="out">Stock Out (Remove / Correction)</option>
        </Select>
        <Input
          label="Quantity"
          type="number"
          step="0.01"
          min="0.01"
          value={quantity}
          onChange={(e) => setQuantity(e.target.value)}
          required
        />
        <Input
          label="Reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="e.g. Restock from supplier, damaged goods"
          required
        />
        <div className="flex gap-3 justify-end pt-2">
          <Button variant="secondary" type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={loading}>
            Apply Adjustment
          </Button>
        </div>
      </form>
    </Modal>
  )
}
