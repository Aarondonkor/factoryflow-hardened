-- READ-ONLY. Run in a database snapshot/staging BEFORE migrations 017-021.
-- Investigate every row; do NOT force constraints over inconsistent history.
SELECT role,COUNT(*) AS accounts FROM public.profiles GROUP BY role ORDER BY role;
SELECT id,email,role,created_at FROM public.profiles
  WHERE role IN ('admin','production_supervisor','sales_staff','hr_officer') ORDER BY created_at DESC;
SELECT profile_id,COUNT(*) AS duplicates FROM public.employees
  WHERE profile_id IS NOT NULL GROUP BY profile_id HAVING COUNT(*)>1;
SELECT id,order_number,status,total,amount_paid FROM public.orders
  WHERE amount_paid<0 OR amount_paid>total;
SELECT id,employee_id,days_worked,hours_worked,gross_pay,deductions FROM public.payroll_records
  WHERE days_worked<0 OR hours_worked<0 OR gross_pay<0 OR deductions<0 OR deductions>gross_pay;
SELECT id,employee_id,attendance_date,clock_in,clock_out FROM public.attendance
  WHERE clock_in IS NOT NULL AND clock_out IS NULL ORDER BY attendance_date DESC LIMIT 50;
SELECT id,reason,start_time,end_time FROM public.machine_downtime
  WHERE end_time<start_time;
SELECT id,employee_id,profile_id FROM public.employees
  WHERE profile_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.profiles p WHERE p.id=employees.profile_id);
-- Legacy aggregate stock vs physical-roll count (existing roll_status values at 016).
SELECT fg.id,fg.product_name,fg.current_stock,
  (SELECT COUNT(*) FROM public.product_rolls pr WHERE pr.finished_good_id=fg.id AND pr.status<>'sold') AS unsold_rolls
FROM public.finished_goods fg WHERE fg.unit='rolls' ORDER BY fg.product_name;
-- Reconcile original payments independently against provider bank settlements.
SELECT payment_method,COUNT(*) AS receipts,COALESCE(SUM(amount),0) AS total
FROM public.payments GROUP BY payment_method ORDER BY payment_method;
-- Check for direct RPC execution permissions in the CURRENT database.
SELECT p.proname,has_function_privilege('anon',p.oid,'EXECUTE') AS anonymous_execute,
  has_function_privilege('authenticated',p.oid,'EXECUTE') AS authenticated_execute
FROM pg_proc p JOIN pg_namespace n ON p.pronamespace=n.oid
WHERE n.nspname='public' AND p.proname IN ('adjust_stock','record_stock_movement','process_payment')
ORDER BY p.proname;
