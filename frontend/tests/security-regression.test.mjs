// Static regression guards. These DO NOT replace role-based PostgreSQL RLS
// tests or Paystack sandbox verification (see TEST_PLAN.md).
import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync,readdirSync} from 'node:fs'
import {resolve} from 'node:path'

const root=resolve(import.meta.dirname,'../..')
const src=(path)=>readFileSync(resolve(root,path),'utf8')
// Supabase migrations use timestamp prefixes (e.g. 20261108000017_...).
// Resolve by a unique descriptive suffix so this works for both legacy
// 017_*.sql and Supabase CLI-compatible timestamped migration filenames.
const migration=(n)=>{
  const suffix=n.replace(/^\d{3}_/,'')
  const migrationDir=resolve(root,'supabase/migrations')
  const matches=readdirSync(migrationDir).filter(file=>
    file===n || file.endsWith(`_${suffix}`)
  )
  assert.equal(matches.length,1,`Expected one migration for ${n}, found: ${matches.join(', ') || 'none'}`)
  return readFileSync(resolve(migrationDir,matches[0]),'utf8')
}

test('the hardened signup trigger ignores client metadata role claims',()=>{
  const sql=migration('017_security_transactions.sql')
  const trigger=sql.split('CREATE OR REPLACE FUNCTION public.handle_new_user()')[1].split('END; $$;')[0]
  assert.doesNotMatch(trigger,/raw_user_meta_data->>\s*'role'/)
  assert.match(trigger,/\), 'customer'\);/)
  assert.match(sql,/REVOKE UPDATE ON public\.profiles FROM anon, authenticated/)
})
test('payment credits are server-verifiable and ledger DML is revoked',()=>{
  const sql=migration('017_security_transactions.sql')
  assert.match(sql,/REVOKE INSERT, UPDATE, DELETE ON public\.stock_movements/)
  assert.match(sql,/public\.payments FROM anon, authenticated/)
  assert.match(sql,/auth\.role\(\) IS DISTINCT FROM 'service_role'/)
  assert.match(src('supabase/functions/_shared/paystack.ts'),/transaction\/verify/)
  assert.match(src('supabase/functions/paystack-webhook/index.ts'),/signatureValid/)
  const ui=readdirSync(resolve(root,'frontend/src/pages/sales')).filter(f=>f.endsWith('.tsx'))
  for(const file of ui)assert.doesNotMatch(src(`frontend/src/pages/sales/${file}`),/\.from\(['"]payments['"]\)\.insert\(/)
})
test('stock and order writes only occur in secured RPCs',()=>{
  const sql=migration('017_security_transactions.sql')
  for(const fn of ['post_production_run','create_staff_order','save_customer_order','change_order_state','record_offline_payment'])
    assert.match(sql,new RegExp(`FUNCTION public\\.${fn}\\(`))
  assert.match(sql,/guard_order_items/)
  assert.match(sql,/reject_posted_mutation/)
})
test('Paystack refunds cannot be posted before the provider confirms processed',()=>{
  const sql=migration('020_verified_refunds.sql')
  assert.match(sql,/p_status<>'processed'/)
  assert.match(sql,/INSERT INTO payment_refunds/)
  assert.match(src('supabase/functions/_shared/refunds.ts'),/reconcilePaystackRefund/)
})
test('rolls can only be consumed by an identified production run',()=>{
  const sql=migration('021_consumed_roll_traceability.sql')
  assert.match(sql,/status='consumed',consumed_in_run_id=v_run/)
  assert.match(sql,/SELECT COUNT\(\*\) INTO v_count_rolls/)
  assert.match(sql,/AND status='available'/)
})
