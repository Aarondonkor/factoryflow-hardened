-- Paystack refunds must be initiated server-side and recognized only after
-- Paystack confirms 'processed'. A pending/failed API response never alters money.
CREATE TABLE public.paystack_refund_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reference TEXT NOT NULL UNIQUE CHECK(length(reference) BETWEEN 8 AND 64),
  payment_id UUID NOT NULL REFERENCES public.payments(id),
  amount NUMERIC(12,2) NOT NULL CHECK(amount>0),
  currency TEXT NOT NULL DEFAULT 'GHS' CHECK(currency='GHS'),
  reason TEXT NOT NULL CHECK(length(trim(reason))>=5),
  requested_by UUID REFERENCES public.profiles(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','needs-attention','processed','failed')),
  provider_refund_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_checked_at TIMESTAMPTZ,
  processed_at TIMESTAMPTZ
);
CREATE INDEX idx_paystack_refunds_payment ON public.paystack_refund_requests(payment_id,created_at DESC);
CREATE UNIQUE INDEX idx_payment_refunds_provider ON public.payment_refunds(provider_refund_id)
  WHERE provider_refund_id IS NOT NULL;
ALTER TABLE public.paystack_refund_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Finance read refund requests" ON public.paystack_refund_requests FOR SELECT
  USING (get_user_role() IN ('admin','sales_staff'));
CREATE POLICY "Customers read own refund requests" ON public.paystack_refund_requests FOR SELECT
  USING (payment_id IN (
    SELECT p.id FROM public.payments p JOIN public.orders o ON o.id=p.order_id
    JOIN public.customers c ON c.id=o.customer_id WHERE c.owner_profile_id=auth.uid()));
REVOKE INSERT,UPDATE,DELETE ON public.paystack_refund_requests FROM anon,authenticated;

CREATE OR REPLACE FUNCTION public.reserve_paystack_refund(p_payment UUID,p_amount NUMERIC,
  p_reason TEXT,p_reference TEXT,p_user UUID)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_payment payments%ROWTYPE; v_used NUMERIC;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Service role required'; END IF;
  IF p_reference !~ '^[A-Za-z0-9_-]{8,64}$' OR LENGTH(TRIM(COALESCE(p_reason,'')))<5 THEN
    RAISE EXCEPTION 'Invalid refund reference/reason'; END IF;
  SELECT * INTO v_payment FROM payments WHERE id=p_payment FOR UPDATE;
  IF NOT FOUND OR v_payment.payment_method<>'paystack' OR v_payment.paystack_reference IS NULL THEN
    RAISE EXCEPTION 'Only previously verified Paystack receipts are eligible'; END IF;
  SELECT COALESCE(SUM(amount),0) INTO v_used FROM (
    SELECT amount FROM payment_refunds WHERE payment_id=p_payment
    UNION ALL
    SELECT amount FROM paystack_refund_requests WHERE payment_id=p_payment
      AND status IN ('pending','processing','needs-attention')
  ) known;
  IF p_amount IS NULL OR p_amount<=0 OR p_amount>v_payment.amount-v_used THEN
    RAISE EXCEPTION 'Refund exceeds unrefunded payment amount'; END IF;
  INSERT INTO paystack_refund_requests(reference,payment_id,amount,reason,requested_by)
    VALUES(p_reference,p_payment,p_amount,p_reason,p_user);
END; $$;
REVOKE ALL ON FUNCTION public.reserve_paystack_refund(UUID,NUMERIC,TEXT,TEXT,UUID) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_paystack_refund(UUID,NUMERIC,TEXT,TEXT,UUID) TO service_role;

CREATE OR REPLACE FUNCTION public.complete_paystack_refund(p_reference TEXT,p_status TEXT,p_provider_id TEXT)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_req paystack_refund_requests%ROWTYPE; v_payment payments%ROWTYPE;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Service role required'; END IF;
  IF p_status NOT IN ('pending','processing','needs-attention','processed','failed') THEN
    RAISE EXCEPTION 'Invalid provider refund status'; END IF;
  SELECT * INTO v_req FROM paystack_refund_requests WHERE reference=p_reference FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Unknown refund reference'; END IF;
  IF v_req.status='processed' THEN
    IF p_status='processed' THEN RETURN FALSE; END IF;
    RAISE EXCEPTION 'Processed refund cannot be reversed locally';
  END IF;
  IF v_req.status='failed' AND p_status<>'failed' THEN
    RAISE EXCEPTION 'Previously failed refund must be reviewed manually'; END IF;
  IF p_status<>'processed' THEN
    UPDATE paystack_refund_requests SET status=p_status,provider_refund_id=p_provider_id WHERE id=v_req.id;
    RETURN FALSE;
  END IF;
  SELECT * INTO v_payment FROM payments WHERE id=v_req.payment_id FOR UPDATE;
  IF NOT FOUND OR v_payment.amount<v_req.amount THEN RAISE EXCEPTION 'Payment amount mismatch'; END IF;
  UPDATE orders SET amount_paid=amount_paid-v_req.amount,
    payment_status=CASE WHEN amount_paid-v_req.amount<=0 THEN 'refunded' ELSE 'partial' END
    WHERE id=v_payment.order_id AND amount_paid>=v_req.amount;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order paid amount is insufficient'; END IF;
  INSERT INTO payment_refunds(payment_id,amount,reason,refunded_by,provider_refund_id)
  VALUES(v_req.payment_id,v_req.amount,v_req.reason,v_req.requested_by,p_reference);
  UPDATE paystack_refund_requests SET status='processed',provider_refund_id=p_provider_id,processed_at=now()
    WHERE id=v_req.id;
  RETURN TRUE;
END; $$;
REVOKE ALL ON FUNCTION public.complete_paystack_refund(TEXT,TEXT,TEXT) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.complete_paystack_refund(TEXT,TEXT,TEXT) TO service_role;

-- Consistent sales reporting computed on the server, not capped client rows.
CREATE OR REPLACE FUNCTION public.sales_metrics()
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  IF auth.uid() IS NULL OR get_user_role() NOT IN ('admin','sales_staff') THEN
    RAISE EXCEPTION 'Sales permission required'; END IF;
  RETURN jsonb_build_object(
    'net_receipts', (SELECT COALESCE(SUM(amount),0) FROM payments) -
      (SELECT COALESCE(SUM(amount),0) FROM payment_refunds),
    'outstanding',(SELECT COALESCE(SUM(balance_due),0) FROM orders WHERE status NOT IN ('pending','cancelled')),
    'order_count',(SELECT COUNT(*) FROM orders),
    'pending_approvals',(SELECT COUNT(*) FROM customers WHERE owner_profile_id IS NOT NULL AND approval_status='pending')
  );
END; $$;
REVOKE ALL ON FUNCTION public.sales_metrics() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.sales_metrics() TO authenticated;
