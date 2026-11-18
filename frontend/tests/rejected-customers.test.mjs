import {test} from 'node:test'
import assert from 'node:assert/strict'
import { URL } from 'node:url';
import {readFileSync} from 'node:fs'
const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8')
test('rejected customers excluded from operational dropdowns',()=>{
 assert.match(read('src/pages/sales/SalesPage.tsx'),/operationalCustomers/)
 assert.match(read('src/pages/inventory/InventoryPage.tsx'),/approval_status\.eq\.approved/)
})
test('rejected applicants visible in separate review, with admin-only deletion',()=>{
 const s=read('src/pages/sales/SalesPage.tsx')
 assert.match(s,/Rejected applications/)
 assert.match(s,/isAdmin && c\.approval_status === 'rejected'/)
})
test('payment initialization denies rejected customers',()=>{
 const s=read('../supabase/functions/paystack-payment/index.ts')
 assert.match(s,/company\?\.approval_status !== 'approved'/)
})
test('server validates admin role and blocks deletes with linked business rows',()=>{
 const s=read('../supabase/migrations/20261118000030_rejected_customer_management.sql')
 assert.match(s,/get_user_role\(\)<>'admin'/)
 assert.match(s,/pg_constraint/)
 assert.match(s,/rejected_customer_deletion_log/)
})
