import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'

const root = resolve(import.meta.dirname, '../..')
const read = (path) => readFileSync(resolve(root, path), 'utf8')

test('admin roll search requires authentication, keeps RLS and caps results', () => {
  const sql = read('supabase/migrations/20261109000022_admin_roll_search.sql')
  assert.match(sql, /SECURITY INVOKER/)
  assert.match(sql, /auth\.uid\(\) IS NULL OR public\.get_user_role\(\) IS DISTINCT FROM 'admin'/)
  assert.match(sql, /LEAST\(GREATEST\(COALESCE\(p_limit, 50\), 1\), 100\)/)
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.search_inventory_rolls.*FROM PUBLIC/)
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.search_inventory_rolls.*TO authenticated/)
})

test('roll search includes customer brand, original production batch, date and pagination', () => {
  const sql = read('supabase/migrations/20261109000022_admin_roll_search.sql')
  assert.match(sql, /LEFT JOIN public\.production_runs pr ON pr\.id = r\.production_run_id/)
  assert.match(sql, /pr\.batch_id, pr\.run_date AS production_date/)
  assert.match(sql, /COALESCE\(NULLIF\(c\.business_name, ''\), c\.name\) AS brand_name/)
  assert.match(sql, /LIMIT v_limit OFFSET v_offset/)
  assert.match(sql, /'total', total\.count, 'rows', results\.rows/)
})

test('individual roll details show batch and production date rather than inferring date from creation time', () => {
  const modal = read('frontend/src/pages/inventory/RollDetailModal.tsx')
  const inventory = read('frontend/src/pages/inventory/InventoryPage.tsx')
  assert.match(modal, /Roll batch ID.*roll\.batch_id/s)
  assert.match(modal, /Date of production.*roll\.production_date/s)
  assert.match(modal, /Roll record created.*roll\.created_at/s)
  assert.match(inventory, /Search branded rolls/)
  assert.match(inventory, /setSelectedRoll\(details\)/)
})
