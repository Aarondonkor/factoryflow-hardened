-- READ-ONLY. Run AFTER migrations 017-021 in staging. Expect no discrepancies
-- except historically known, physically unreconciled roll inventory.
SELECT id,product_name,recorded_stock,counted_rolls FROM public.roll_stock_discrepancies;
SELECT id,order_number,status,delivery_status,payment_status,total,amount_paid FROM public.orders
WHERE amount_paid<0 OR amount_paid>total;
SELECT reference,order_id,amount,status,settled_at FROM public.payment_attempts
  ORDER BY created_at DESC LIMIT 20;
SELECT reference,payment_id,amount,status,processed_at FROM public.paystack_refund_requests
  ORDER BY created_at DESC LIMIT 20;
SELECT role,COUNT(*) FROM public.profiles GROUP BY role;
SELECT p.proname,has_function_privilege('anon',p.oid,'EXECUTE') anon_exec,
 has_function_privilege('authenticated',p.oid,'EXECUTE') authenticated_exec,
 has_function_privilege('service_role',p.oid,'EXECUTE') service_exec
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='public' AND p.proname IN (
 'record_stock_movement','adjust_stock','post_production_run','create_staff_order',
 'save_customer_order','change_order_state','settle_verified_paystack',
 'reserve_paystack_refund','complete_paystack_refund') ORDER BY p.proname;
-- Check that all stores are protected by RLS and table privileges, not only UI.
SELECT c.relname,c.relrowsecurity,
 has_table_privilege('authenticated',c.oid,'INSERT') auth_can_insert,
 has_table_privilege('authenticated',c.oid,'UPDATE') auth_can_update,
 has_table_privilege('authenticated',c.oid,'DELETE') auth_can_delete
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='public' AND c.relname IN ('orders','order_items','payments',
 'stock_movements','production_runs','production_run_materials','product_rolls','payment_refunds')
ORDER BY c.relname;
