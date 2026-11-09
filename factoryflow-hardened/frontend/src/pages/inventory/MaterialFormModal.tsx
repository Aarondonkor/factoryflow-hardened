import { useState } from 'react'
import { supabase } from '@/lib/supabase'
import { useToastStore } from '@/stores/toastStore'
import type { Customer } from '@/types/database'
import { Modal } from '@/components/ui/Modal'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Button } from '@/components/ui/Button'

interface MaterialFormModalProps {
  type: 'raw' | 'finished'
  customers?: Customer[]
  onClose: () => void
  onSuccess: () => void
}

export function MaterialFormModal({ type, customers = [], onClose, onSuccess }: MaterialFormModalProps) {
  const [loading, setLoading] = useState(false)
  const addToast = useToastStore((s) => s.addToast)

  const [rawForm, setRawForm] = useState({
    name: '',
    unit: 'kg',
    current_stock: '0',
    reorder_threshold: '0',
    supplier_name: '',
    supplier_contact: '',
  })

  const [finForm, setFinForm] = useState({
    product_name: '',
    spec_thickness: '',
    spec_width: '',
    color: '',
    unit: 'kg' as 'kg' | 'rolls' | 'bundle',
    current_stock: '0',
    warehouse_location: '',
    stage: 'finished' as 'semi_finished' | 'finished',
    customer_id: '',
    unit_price: '',
    bundle_size: '',
    customer_orderable: true,
  })

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)

    if (type === 'raw') {
      const { error } = await supabase.from('raw_materials').insert({
        name: rawForm.name,
        unit: rawForm.unit,
        current_stock: 0,
        reorder_threshold: parseFloat(rawForm.reorder_threshold) || 0,
        supplier_name: rawForm.supplier_name || null,
        supplier_contact: rawForm.supplier_contact || null,
      })
      if (error) addToast(error.message, 'error')
      else onSuccess()
    } else {
      const { error } = await supabase.from('finished_goods').insert({
        product_name: finForm.product_name,
        spec_thickness: finForm.spec_thickness ? parseFloat(finForm.spec_thickness) : null,
        spec_width: finForm.spec_width ? parseFloat(finForm.spec_width) : null,
        color: finForm.color || null,
        unit: finForm.unit,
        current_stock: 0,
        warehouse_location: finForm.warehouse_location || null,
        stage: finForm.stage,
        customer_id: finForm.customer_id || null,
        unit_price: finForm.unit_price ? parseFloat(finForm.unit_price) : null,
        bundle_size: finForm.unit === 'bundle' && finForm.bundle_size ? parseInt(finForm.bundle_size, 10) : null,
        customer_orderable: finForm.customer_orderable,
      })
      if (error) addToast(error.message, 'error')
      else onSuccess()
    }

    setLoading(false)
  }

  return (
    <Modal
      open
      title={type === 'raw' ? 'Add Raw Material' : 'Add Finished Product'}
      onClose={onClose}
      size="lg"
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        {type === 'raw' ? (
          <>
            <Input
              label="Material Name"
              value={rawForm.name}
              onChange={(e) => setRawForm({ ...rawForm, name: e.target.value })}
              required
            />
            <div className="grid grid-cols-2 gap-4">
              <Input
                label="Current Stock (use Stock Adjustment after saving)"
                type="number"
                step="0.01"
                value={rawForm.current_stock}
                disabled
                onChange={(e) => setRawForm({ ...rawForm, current_stock: e.target.value })}
              />
              <Input
                label="Reorder Threshold"
                type="number"
                step="0.01"
                value={rawForm.reorder_threshold}
                onChange={(e) => setRawForm({ ...rawForm, reorder_threshold: e.target.value })}
              />
            </div>
            <Input
              label="Supplier Name"
              value={rawForm.supplier_name}
              onChange={(e) => setRawForm({ ...rawForm, supplier_name: e.target.value })}
            />
            <Input
              label="Supplier Contact"
              value={rawForm.supplier_contact}
              onChange={(e) => setRawForm({ ...rawForm, supplier_contact: e.target.value })}
            />
          </>
        ) : (
          <>
            <Input
              label="Product Name"
              value={finForm.product_name}
              onChange={(e) => setFinForm({ ...finForm, product_name: e.target.value })}
              required
            />
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
              <Input
                label="Thickness (µ)"
                type="number"
                value={finForm.spec_thickness}
                onChange={(e) => setFinForm({ ...finForm, spec_thickness: e.target.value })}
              />
              <Input
                label="Width (mm)"
                type="number"
                value={finForm.spec_width}
                onChange={(e) => setFinForm({ ...finForm, spec_width: e.target.value })}
              />
              <Input
                label="Color"
                value={finForm.color}
                onChange={(e) => setFinForm({ ...finForm, color: e.target.value })}
              />
            </div>
            {finForm.unit === 'rolls' && (
              <p className="text-xs text-slate-500 -mt-2">
                For roll products, leave Thickness blank if the customer specifies their own micron
                on each order (typical for branded rolls) — the requested micron is captured per
                order, not fixed on the product.
              </p>
            )}
            <div className="grid grid-cols-2 gap-4">
              <Select
                label="Unit"
                value={finForm.unit}
                onChange={(e) => setFinForm({ ...finForm, unit: e.target.value as 'kg' | 'rolls' | 'bundle' })}
              >
                <option value="kg">Kilograms (kg)</option>
                <option value="rolls">Rolls</option>
                <option value="bundle">Bundle</option>
              </Select>
              <Input
                label="Warehouse Location"
                value={finForm.warehouse_location}
                onChange={(e) => setFinForm({ ...finForm, warehouse_location: e.target.value })}
              />
            </div>

            {finForm.unit === 'bundle' && (
              <Input
                label="Pieces per Bundle"
                type="number"
                value={finForm.bundle_size}
                onChange={(e) => setFinForm({ ...finForm, bundle_size: e.target.value })}
                placeholder="e.g. 100"
              />
            )}

            <div className="border-t pt-4">
              <p className="text-sm font-medium text-slate-700 mb-3">Production Stage & Customer Ordering</p>
              <div className="grid grid-cols-2 gap-4">
                <Select
                  label="Stage"
                  value={finForm.stage}
                  onChange={(e) => setFinForm({ ...finForm, stage: e.target.value as 'semi_finished' | 'finished' })}
                >
                  <option value="semi_finished">Semi-Finished (raw roll)</option>
                  <option value="finished">Finished</option>
                </Select>
                <Input
                  label="List Price (GHS) — per kg for roll products"
                  type="number"
                  step="0.01"
                  value={finForm.unit_price}
                  onChange={(e) => setFinForm({ ...finForm, unit_price: e.target.value })}
                  placeholder="Leave blank to hide from customer portal"
                />
              </div>
              <Select
                label="Exclusive to Company"
                className="mt-4"
                value={finForm.customer_id}
                onChange={(e) => setFinForm({ ...finForm, customer_id: e.target.value })}
              >
                <option value="">— Generally available to all customers —</option>
                {customers.map((c) => (
                  <option key={c.id} value={c.id}>{c.business_name || c.name} (branded product)</option>
                ))}
              </Select>
              <label className="mt-4 flex items-center gap-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={finForm.customer_orderable}
                  onChange={(e) => setFinForm({ ...finForm, customer_orderable: e.target.checked })}
                />
                Visible in customer portal (uncheck to keep internal-only)
              </label>
            </div>
          </>
        )}
        <div className="flex gap-3 justify-end pt-2">
          <Button variant="secondary" type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={loading}>
            Save
          </Button>
        </div>
      </form>
    </Modal>
  )
}
