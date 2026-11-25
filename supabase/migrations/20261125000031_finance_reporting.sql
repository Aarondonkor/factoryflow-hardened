-- Finance: receipts come only from the existing payments ledger, not browser callbacks.
-- Period cashflow is not profit and is not Paystack-to-MoMo settlement confirmation.
CREATE TABLE IF NOT EXISTS public.finance_expenses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  expense_date date NOT NULL DEFAULT (now() AT TIME ZONE 'Africa/Accra')::date,
  category text NOT NULL CHECK (category IN ('raw_materials','utilities','transport','payroll','maintenance','rent','taxes','bank_fees','other')),
  description text NOT NULL CHECK (length(btrim(description)) BETWEEN 3 AND 500),
  amount numeric(14,2) NOT NULL CHECK (amount > 0 AND amount <= 100000000),
  paid_via text NOT NULL CHECK (paid_via IN ('cash','mobile_money','bank_transfer','other')),
  external_reference text,
  created_by uuid NOT NULL REFERENCES public.profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT finance_expenses_reference_length CHECK (length(coalesce(external_reference,'')) <= 120)
);
CREATE INDEX IF NOT EXISTS idx_finance_expenses_date ON public.finance_expenses(expense_date DESC,created_at DESC);
ALTER TABLE public.finance_expenses ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.finance_expenses FROM anon,authenticated;
-- Accounting data is admin-only. Expense records are append-only; corrections are new entries.

CREATE OR REPLACE FUNCTION public.finance_record_expense(
 p_date date,p_category text,p_description text,p_amount numeric,p_paid_via text,p_reference text DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_id uuid;
BEGIN
 IF auth.uid() IS NULL OR public.get_user_role() <> 'admin' THEN
   RAISE EXCEPTION 'Administrator required' USING ERRCODE = '42501';
 END IF;
 IF p_date IS NULL OR p_date > (now() AT TIME ZONE 'Africa/Accra')::date OR
    p_date < DATE '2000-01-01' THEN RAISE EXCEPTION 'Invalid expense date'; END IF;
 INSERT INTO public.finance_expenses(expense_date,category,description,amount,paid_via,external_reference,created_by)
 VALUES (p_date,p_category,btrim(p_description),p_amount,p_paid_via,NULLIF(btrim(p_reference),''),auth.uid())
 RETURNING id INTO v_id;
 RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION public.finance_record_expense(date,text,text,numeric,text,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.finance_record_expense(date,text,text,numeric,text,text) TO authenticated;

CREATE OR REPLACE FUNCTION public.finance_report(p_start date,p_end date)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_data jsonb;
BEGIN
 IF auth.uid() IS NULL OR public.get_user_role() <> 'admin' THEN
   RAISE EXCEPTION 'Administrator required' USING ERRCODE = '42501';
 END IF;
 IF p_start IS NULL OR p_end IS NULL OR p_end < p_start OR p_end - p_start > 366 THEN
   RAISE EXCEPTION 'Choose a reporting period of at most 367 days';
 END IF;
 WITH receipts AS (
   SELECT p.id,p.order_id,p.amount,p.payment_method::text method,p.paystack_reference,
     p.created_at,(p.created_at AT TIME ZONE 'Africa/Accra')::date AS entry_day,
     o.order_number
   FROM public.payments p JOIN public.orders o ON o.id=p.order_id
   WHERE (p.created_at AT TIME ZONE 'Africa/Accra')::date BETWEEN p_start AND p_end
 ), refunds AS (
   SELECT r.id,r.amount,r.created_at,(r.created_at AT TIME ZONE 'Africa/Accra')::date AS entry_day,
     p.order_id,o.order_number,r.reason
   FROM public.payment_refunds r JOIN public.payments p ON p.id=r.payment_id
   JOIN public.orders o ON o.id=p.order_id
   WHERE (r.created_at AT TIME ZONE 'Africa/Accra')::date BETWEEN p_start AND p_end
 ), expenses AS (
   SELECT id,expense_date AS entry_day,category,description,amount,paid_via,external_reference
   FROM public.finance_expenses WHERE expense_date BETWEEN p_start AND p_end
 ), activity AS (
   SELECT 'receipt'::text kind,id::text entry_id,entry_day,amount,order_number detail,method category,
     coalesce(paystack_reference,'') reference FROM receipts
   UNION ALL SELECT 'refund',id::text,entry_day,-amount,order_number, 'refund',reason FROM refunds
   UNION ALL SELECT 'expense',id::text,entry_day,-amount,description,category,coalesce(external_reference,'') FROM expenses
 ), daily AS (
   SELECT entry_day,sum(amount) FILTER (WHERE kind='receipt') receipts,
     -sum(amount) FILTER (WHERE kind='refund') refunds,
     -sum(amount) FILTER (WHERE kind='expense') expenses
   FROM activity GROUP BY entry_day
 )
 SELECT jsonb_build_object(
    'totals',jsonb_build_object(
      'gross_receipts',(SELECT coalesce(sum(amount),0) FROM receipts),
      'refunds',(SELECT coalesce(sum(amount),0) FROM refunds),
      'expenses',(SELECT coalesce(sum(amount),0) FROM expenses),
      'net_cashflow',(SELECT coalesce(sum(amount),0) FROM receipts) -
          (SELECT coalesce(sum(amount),0) FROM refunds) - (SELECT coalesce(sum(amount),0) FROM expenses),
      'outstanding_orders',(SELECT coalesce(sum(greatest(total-amount_paid,0)),0)
        FROM public.orders WHERE status::text NOT IN ('cancelled','rejected'))
    ),
    'daily',(SELECT coalesce(jsonb_agg(jsonb_build_object('date', d.entry_day::text,
       'receipts',coalesce(x.receipts,0),'refunds',coalesce(x.refunds,0),
       'expenses',coalesce(x.expenses,0),'net',coalesce(x.receipts,0)-coalesce(x.refunds,0)-coalesce(x.expenses,0)) ORDER BY d.entry_day),'[]'::jsonb)
       FROM (SELECT p_start + n AS entry_day FROM generate_series(0,p_end-p_start) n) d LEFT JOIN daily x ON x.entry_day=d.entry_day),
    'entries',(SELECT coalesce(jsonb_agg(jsonb_build_object('type',kind,'id',entry_id,'date',entry_day::text,
      'amount',amount,'detail',detail,'category',category,'reference',reference) ORDER BY entry_day DESC,kind,entry_id),'[]'::jsonb)
      FROM (SELECT * FROM activity ORDER BY entry_day DESC,kind,entry_id LIMIT 2000) t),
    'expense_categories',(SELECT coalesce(jsonb_agg(jsonb_build_object('name',category,'amount',amount) ORDER BY amount DESC),'[]'::jsonb)
      FROM (SELECT category,sum(amount) amount FROM expenses GROUP BY category) c)
 ) INTO v_data;
 RETURN v_data;
END $$;
REVOKE ALL ON FUNCTION public.finance_report(date,date) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.finance_report(date,date) TO authenticated;

COMMENT ON FUNCTION public.finance_report(date,date) IS
 'Admin cashflow summary. Receipts are posted payments; refunds are posted refunds. Does not establish Paystack payout settlement, accrual revenue, or net profit.';
NOTIFY pgrst, 'reload schema';
