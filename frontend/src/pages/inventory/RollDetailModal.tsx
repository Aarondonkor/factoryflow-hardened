import type { ReactNode } from 'react'
import { Badge } from '@/components/ui/Badge'
import { Modal } from '@/components/ui/Modal'
import { formatDate, formatDateTime, formatKg } from '@/lib/format'
import type { InventoryRollRecord } from './rollSearch'

interface RollDetailModalProps {
  roll: InventoryRollRecord | null
  onClose: () => void
}

function Detail({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="min-w-0 border-b border-slate-100 py-2.5">
      <dt className="text-xs font-medium text-slate-500">{label}</dt>
      <dd className="mt-1 break-words text-sm font-medium text-slate-900">{value ?? 'Not recorded'}</dd>
    </div>
  )
}

export function RollDetailModal({ roll, onClose }: RollDetailModalProps) {
  if (!roll) return null
  const statusVariant = roll.status === 'available' ? 'success' : roll.status === 'reserved' ? 'warning' : 'default'
  return (
    <Modal open={true} onClose={onClose} title={`Roll #${roll.roll_no} — Details`} size="lg">
      <div className="space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-slate-50 p-4">
          <div>
            <p className="text-base font-semibold text-slate-900">{roll.product_name || 'Unknown product'}</p>
            <p className="text-xs text-slate-500">{roll.brand_name || 'No customer brand assigned'}</p>
          </div>
          <Badge variant={statusVariant}>{roll.status}</Badge>
        </div>
        <section aria-label="Production batch information">
          <h3 className="font-semibold text-brand-900">Production batch</h3>
          <dl className="grid grid-cols-1 gap-x-5 sm:grid-cols-2">
            <Detail label="Roll batch ID" value={roll.batch_id || 'Not recorded'} />
            <Detail label="Date of production" value={roll.production_date ? formatDate(roll.production_date) : 'Not recorded'} />
            <Detail label="Production run ID" value={roll.production_run_id || 'Not linked to a production run'} />
            <Detail label="Shift" value={roll.production_shift || 'Not recorded'} />
            <Detail label="Machine" value={[roll.machine_code, roll.machine_name].filter(Boolean).join(' — ') || 'Not recorded'} />
            <Detail label="Operator" value={roll.operator_name || 'Not recorded'} />
            <Detail label="Supervisor" value={roll.supervisor_name || 'Not recorded'} />
            <Detail label="Process" value={roll.process_type || 'Not recorded'} />
            <Detail label="Production quality grade" value={roll.quality_grade ?? 'Not recorded'} />
            <Detail label="Production notes" value={roll.production_notes || 'Not recorded'} />
          </dl>
        </section>
        <section aria-label="Individual roll information">
          <h3 className="font-semibold text-brand-900">Individual roll</h3>
          <dl className="grid grid-cols-1 gap-x-5 sm:grid-cols-2">
            <Detail label="Roll number" value={`#${roll.roll_no}`} />
            <Detail label="Weight" value={formatKg(Number(roll.weight_kg))} />
            <Detail label="Thickness (micron)" value={roll.micron != null ? `${roll.micron} µ` : 'Not recorded'} />
            <Detail label="Specification width" value={roll.product_spec_width != null ? `${roll.product_spec_width} mm` : 'Not recorded'} />
            <Detail label="Product colour" value={roll.product_color || 'Not recorded'} />
            <Detail label="Product stage" value={roll.product_stage || 'Not recorded'} />
            <Detail label="Warehouse location" value={roll.warehouse_location || 'Not recorded'} />
            <Detail label="Assigned brand / customer" value={roll.brand_name || 'Not assigned'} />
            <Detail label="Order item ID" value={roll.order_item_id || 'Not assigned'} />
            <Detail label="Roll record created" value={formatDateTime(roll.created_at)} />
            <Detail label="Production record created" value={roll.run_logged_at ? formatDateTime(roll.run_logged_at) : 'Not recorded'} />
            <Detail label="Roll record ID" value={roll.id} />
          </dl>
        </section>
        <p className="text-xs text-slate-500">
          Production date comes from the linked production report. It may differ from the date this roll record was entered.
          A roll created by stock reconciliation may not have a linked batch.
        </p>
      </div>
    </Modal>
  )
}
