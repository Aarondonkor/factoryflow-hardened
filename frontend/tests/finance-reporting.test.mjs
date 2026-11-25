import { test } from 'node:test'
import { URL } from 'node:url';
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('../..', import.meta.url))
const migration = readFileSync(`${root}/supabase/migrations/20261125000031_finance_reporting.sql`, 'utf8')
const frontend = readFileSync(`${root}/frontend/src/pages/finance/FinancePage.tsx`, 'utf8')

test('Finance permissions are restricted to an authenticated administrator',()=>{
  assert.match(migration,/public\.get_user_role\(\) <> 'admin'/)
  assert.match(migration,/REVOKE ALL ON public\.finance_expenses FROM anon,authenticated/)
  assert.match(migration,/REVOKE ALL ON FUNCTION public\.finance_report\(date,date\) FROM PUBLIC,anon/)
})
test('Receipts and refunds are calculated from existing posted financial ledgers',()=>{
  assert.match(migration,/FROM public\.payments p JOIN public\.orders o/)
  assert.match(migration,/FROM public\.payment_refunds r JOIN public\.payments p/)
  assert.match(migration,/net_cashflow/)
  assert.doesNotMatch(migration,/INSERT INTO public\.payments/)
})
test('Expense records use restricted append-only RPC and positive amounts',()=>{
  assert.match(migration,/amount numeric\(14,2\) NOT NULL CHECK \(amount > 0/)
  assert.match(migration,/CREATE OR REPLACE FUNCTION public\.finance_record_expense/)
  assert.match(frontend,/finance_record_expense/)
})
test('Finance view has charts and safe CSV export',()=>{
  assert.match(frontend,/BarChart/)
  assert.match(frontend,/PieChart/)
  assert.match(frontend,/Export Excel CSV/)
  assert.ok(
  frontend.includes(`safe.replace(/"/g, '""')`) ||
  frontend.includes(`safe.replaceAll('"','""')`),
  'CSV exports must escape embedded double quotation marks'
)
})
