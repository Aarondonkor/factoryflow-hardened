import type { ProductRoll } from '@/types/database'

/** Read-only search record returned by search_inventory_rolls. */
export interface InventoryRollRecord extends ProductRoll {
  product_name: string | null
  product_stage: string | null
  product_spec_thickness: number | null
  product_spec_width: number | null
  product_color: string | null
  warehouse_location: string | null
  brand_name: string | null
  customer_id: string | null
  batch_id: string | null
  production_date: string | null
  production_shift: string | null
  operator_name: string | null
  supervisor_name: string | null
  quality_grade: number | null
  production_notes: string | null
  process_type: string | null
  run_logged_at: string | null
  machine_name: string | null
  machine_code: string | null
}

export const ROLL_PAGE_SIZE = 50

export function asRollSearchResult(data: unknown): { rows: InventoryRollRecord[]; total: number } {
  if (!data || typeof data !== 'object') throw new Error('Unexpected roll search response')
  const value = data as { rows?: unknown; total?: unknown }
  if (!Array.isArray(value.rows) || typeof value.total !== 'number' || !Number.isFinite(value.total)) {
    throw new Error('Invalid roll search results')
  }
  return { rows: value.rows as InventoryRollRecord[], total: value.total }
}
