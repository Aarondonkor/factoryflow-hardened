import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
const src = (path) => readFileSync(join(root, path), 'utf8')
const migration = src('supabase/migrations/20261115000026_customer_stock_and_production_preorders.sql')
const portal = src('frontend/src/pages/customer/CustomerPortalPage.tsx')
const stockUi = src('frontend/src/pages/customer/CustomerStockPage.tsx')
const sales = src('frontend/src/pages/sales/SalesPage.tsx')
const allocation = src('frontend/src/components/orders/ProductionRollAllocationModal.tsx')
const payments = src('supabase/functions/paystack-payment/index.ts')

// Source invariants. Run an additional live staging test before taking money.
test('customer-owned stock inventory is computed from available physical rolls in the database', () => {
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.customer_available_stock\(\)/)
  assert.match(migration, /fg\.customer_id=v_customer/)
  assert.match(migration, /pr\.status='available'/)
  assert.match(migration, /get_user_role\(\)<>'customer'/)
  assert.match(portal, /supabase\.rpc\('customer_available_stock'\)/)
  assert.match(portal, /label: 'My Stock'/)
  assert.match(stockUi, /available_roll_count/)
})

test('production request is company-bound and enforces exactly five or more rolls at 20 kg nominal each', () => {
  assert.match(migration,/CREATE OR REPLACE FUNCTION public\.customer_request_production_order/)
  assert.match(migration,/p_roll_count NOT BETWEEN 5 AND 1000/)
  assert.match(migration,/p_roll_count\*20/)
  assert.match(migration,/fg\.customer_id=v_customer/)
  assert.match(migration,/fg\.unit='rolls' AND fg\.customer_orderable/)
  assert.match(migration,/EXISTS\(SELECT 1 FROM public\.product_rolls pr/)
  assert.match(migration,/WHEN p_roll_count>5 THEN CEIL\(o\.total\*50\)\/100 ELSE 0/)
  assert.match(stockUi,/Number\.isInteger\(count\) && count>=5/)
  assert.match(stockUi,/Pay at least 50%/)
})

test('micron is validated by the database against the branded product range',()=>{
  assert.match(migration,/v_micron:=COALESCE\(p_micron,v_micron\)/)
  assert.match(migration,/v_min IS NOT NULL AND v_micron<v_min/)
  assert.match(migration,/v_max IS NOT NULL AND v_micron>v_max/)
  assert.match(stockUi,/p_micron:micronValue/)
})

test('deposit cannot be forged or bypassed by confirming early',()=>{
  assert.match(migration,/NEW\.amount_paid<NEW\.deposit_required/)
  assert.match(migration,/IF OLD\.fulfillment_mode='made_to_order' AND NEW\.total<>OLD\.total/)
  assert.match(migration,/CREATE TRIGGER trg_guard_production_request_lines/)
  assert.match(payments,/const amount = isDeposit \? Math\.round\(due\*100\)\/100/)
  assert.match(payments,/payment_kind:'deposit'/)
  assert.match(migration,/idx_one_pending_deposit_attempt/)
  assert.match(migration,/v_attempt\.payment_kind='deposit'/)
  assert.match(payments,/authorization_url:outstanding\.authorization_url/)
})

test('physical stock is debited only when a production order is allocated, never at confirmation',()=>{
  assert.match(migration,/IF NEW\.fulfillment_mode='made_to_order' THEN RETURN NEW; END IF;/)
  assert.match(migration,/CREATE OR REPLACE FUNCTION public\.allocate_production_order_rolls/)
  assert.match(migration,/v_weight<v_order\.production_target_kg/)
  assert.match(migration,/current_stock=current_stock-v_count/)
  assert.match(migration,/CREATE OR REPLACE FUNCTION public\.restore_cancelled_order/)
  assert.match(migration,/IF v_count=0 THEN CONTINUE; END IF;/)
  assert.match(migration,/before dispatch/)
  assert.match(sales,/setAllocationOrder\(o\)/)
  assert.match(allocation,/supabase\.rpc\('allocate_production_order_rolls'/)
})

test('client redirects to verified Paystack checkout and permits later deposit retry',()=>{
  assert.match(stockUi,/await startVerifiedCheckout\(id\)/)
  assert.match(stockUi,/Pay from My Orders/)
  assert.match(src('frontend/src/components/orders/OrderDetailModal.tsx'),/Pay 50% Deposit/)
  assert.match(payments,/const tx = await initialize\(\)/)
  assert.match(payments,/paystack\('\/transaction\/initialize'/)
  assert.match(payments,/action === 'verify'/)
  assert.match(src('supabase/functions/paystack-webhook/index.ts'),/verifyAndSettle\(event\.data\.reference\)/)
})
