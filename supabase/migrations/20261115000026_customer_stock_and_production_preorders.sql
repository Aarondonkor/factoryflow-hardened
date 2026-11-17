-- FactoryFlow: customer-owned branded stock and made-to-order roll requests.
-- 5 rolls = 100 kg nominal, 20 kg nominal per roll. 100 kg requires no deposit;
-- more than 100 kg requires at least a 50% verified deposit BEFORE confirmation.
-- This migration is additive: existing stock orders continue unchanged.

ALTER TABLE public.orders
  ADD COLUMN fulfillment_mode text NOT NULL DEFAULT 'stock'
    CHECK (fulfillment_mode IN ('stock','made_to_order')),
  ADD COLUMN production_rolls_requested integer,
  ADD COLUMN production_target_kg numeric(12,2),
  ADD COLUMN deposit_required numeric(12,2) NOT NULL DEFAULT 0
    CHECK (deposit_required >= 0);

ALTER TABLE public.orders ADD CONSTRAINT orders_production_request_shape CHECK (
  (fulfillment_mode='stock' AND production_rolls_requested IS NULL
    AND production_target_kg IS NULL AND deposit_required=0)
  OR
  (fulfillment_mode='made_to_order' AND production_rolls_requested BETWEEN 5 AND 1000
    AND production_target_kg=production_rolls_requested*20)
);
COMMENT ON COLUMN public.orders.production_target_kg IS
  'Nominal kg (20 kg per ordered roll). Actual fulfilled weight is measured from the allocated physical rolls.';
COMMENT ON COLUMN public.orders.deposit_required IS
  'Server-calculated minimum advance payment; >100kg production requests require 50% of order total, rounded up to the next pesewa.';

-- Customers see only their own branded catalog and the actual AVAILABLE physical
-- rolls for each product, without relying on a 1000-row client pagination limit.
CREATE OR REPLACE FUNCTION public.customer_available_stock()
RETURNS TABLE (
  finished_good_id uuid,
  product_name text,
  stage public.product_stage,
  unit public.output_unit,
  available_quantity numeric,
  available_roll_count bigint,
  available_weight_kg numeric,
  unit_price numeric,
  customer_orderable boolean,
  spec_thickness numeric,
  spec_thickness_min numeric,
  spec_thickness_max numeric
) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_customer uuid;
BEGIN
  IF auth.uid() IS NULL OR public.get_user_role()<>'customer' THEN
    RAISE EXCEPTION 'Customer session required' USING ERRCODE='42501';
  END IF;
  SELECT c.id INTO v_customer FROM public.customers c
  WHERE c.owner_profile_id=auth.uid();
  IF v_customer IS NULL THEN RAISE EXCEPTION 'Customer profile missing'; END IF;
  RETURN QUERY
  SELECT fg.id,fg.product_name,fg.stage,fg.unit,
    CASE WHEN fg.unit='rolls' THEN COALESCE(r.roll_count,0)::numeric
         ELSE fg.current_stock END,
    COALESCE(r.roll_count,0),COALESCE(r.weight_kg,0),fg.unit_price,
    fg.customer_orderable,fg.spec_thickness,fg.spec_thickness_min,fg.spec_thickness_max
  FROM public.finished_goods fg
  LEFT JOIN LATERAL (
    SELECT COUNT(*)::bigint AS roll_count,COALESCE(SUM(pr.weight_kg),0)::numeric AS weight_kg
    FROM public.product_rolls pr
    WHERE pr.finished_good_id=fg.id AND pr.status='available'
  ) r ON true
  WHERE fg.customer_id=v_customer
  ORDER BY fg.product_name;
END; $$;
REVOKE ALL ON FUNCTION public.customer_available_stock() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.customer_available_stock() TO authenticated;

-- A dedicated RPC creates a ONE-product production request for a branded roll
-- product which has no physical available rolls. Prices and the 50% deposit are
-- calculated from the database, never from untrusted browser input.
CREATE OR REPLACE FUNCTION public.customer_request_production_order(
  p_finished_good uuid,p_roll_count integer,p_delivery_date date,p_notes text,p_micron numeric
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_customer uuid; v_price numeric; v_micron numeric; v_min numeric; v_max numeric; v_order uuid;
BEGIN
  IF auth.uid() IS NULL OR public.get_user_role()<>'customer' THEN
    RAISE EXCEPTION 'Customer login required' USING ERRCODE='42501'; END IF;
  SELECT c.id INTO v_customer FROM public.customers c
    WHERE c.owner_profile_id=auth.uid() AND c.approval_status='approved';
  IF v_customer IS NULL THEN RAISE EXCEPTION 'Your company account must be approved'; END IF;
  IF p_roll_count IS NULL OR p_roll_count NOT BETWEEN 5 AND 1000 THEN
    RAISE EXCEPTION 'Minimum production order: 5 rolls (100 kg)'; END IF;
  IF p_delivery_date IS NOT NULL AND p_delivery_date<CURRENT_DATE THEN
    RAISE EXCEPTION 'Delivery date cannot be in the past'; END IF;
  SELECT fg.unit_price,fg.spec_thickness,fg.spec_thickness_min,fg.spec_thickness_max
    INTO v_price,v_micron,v_min,v_max
    FROM public.finished_goods fg
    WHERE fg.id=p_finished_good AND fg.customer_id=v_customer
      AND fg.unit='rolls' AND fg.customer_orderable
      AND fg.unit_price IS NOT NULL AND fg.unit_price>0
    FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Select an authorized branded roll product with a valid price'; END IF;
  v_micron:=COALESCE(p_micron,v_micron);
  IF v_micron IS NULL OR v_micron<=0
    OR (v_min IS NOT NULL AND v_micron<v_min)
    OR (v_max IS NOT NULL AND v_micron>v_max) THEN
    RAISE EXCEPTION 'Enter a valid micron thickness within the permitted product range'; END IF;
  IF EXISTS(SELECT 1 FROM public.product_rolls pr
      WHERE pr.finished_good_id=p_finished_good AND pr.status='available') THEN
    RAISE EXCEPTION 'This product has available stock. Order the physical rolls from My Stock';
  END IF;
  INSERT INTO public.orders(customer_id,delivery_date,notes,created_by,status,
    fulfillment_mode,production_rolls_requested,production_target_kg)
  VALUES(v_customer,p_delivery_date,NULLIF(left(trim(coalesce(p_notes,'')),1000),''),
    auth.uid(),'pending','made_to_order',p_roll_count,p_roll_count*20)
  RETURNING id INTO v_order;

  -- Existing roll-product validation allows physical-roll picker lines only;
  -- this explicitly authorized RPC may insert one nominal production line.
  PERFORM set_config('app.roll_order','on',true);
  PERFORM set_config('app.production_request_insert','on',true);
  INSERT INTO public.order_items(order_id,finished_good_id,quantity,unit_price,specified_micron)
    VALUES(v_order,p_finished_good,p_roll_count*20,v_price,v_micron);
  PERFORM set_config('app.production_request_insert','off',true);
  PERFORM set_config('app.roll_order','off',true);
  UPDATE public.orders o SET deposit_required=CASE
    WHEN p_roll_count>5 THEN CEIL(o.total*50)/100 ELSE 0 END
  WHERE o.id=v_order;
  RETURN v_order;
END; $$;
REVOKE ALL ON FUNCTION public.customer_request_production_order(uuid,integer,date,text,numeric) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.customer_request_production_order(uuid,integer,date,text,numeric) TO authenticated;

-- No existing stock-order editing RPC may replace an immutable production quote
-- (especially after a deposit has been paid).
CREATE OR REPLACE FUNCTION public.guard_production_request_lines()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_mode text; v_order uuid;
BEGIN
  v_order:=CASE WHEN TG_OP='DELETE' THEN OLD.order_id ELSE NEW.order_id END;
  SELECT o.fulfillment_mode INTO v_mode FROM public.orders o WHERE o.id=v_order;
  IF v_mode='made_to_order' AND NOT (
      TG_OP='INSERT' AND current_setting('app.production_request_insert',true)='on') THEN
    RAISE EXCEPTION 'Production request quantities and prices are locked; contact sales to amend';
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END; $$;
CREATE TRIGGER trg_guard_production_request_lines
BEFORE INSERT OR UPDATE OR DELETE ON public.order_items
FOR EACH ROW EXECUTE FUNCTION public.guard_production_request_lines();

-- Validate deposit before an order is confirmed, and allocation before dispatch.
-- Replaces the earlier transition trigger body; preserves all original rules.
CREATE OR REPLACE FUNCTION public.guard_order_transition()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_rolls bigint; v_weight numeric;
BEGIN
  IF NEW.customer_id<>OLD.customer_id OR NEW.fulfillment_mode<>OLD.fulfillment_mode
      OR NEW.production_rolls_requested IS DISTINCT FROM OLD.production_rolls_requested
      OR NEW.production_target_kg IS DISTINCT FROM OLD.production_target_kg THEN
    RAISE EXCEPTION 'Order ownership and production specification are immutable'; END IF;
  IF OLD.fulfillment_mode='made_to_order' AND NEW.total<>OLD.total
    AND current_setting('app.production_request_insert',true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'Production quote cannot be changed'; END IF;
  IF NEW.status<>OLD.status AND NOT (
    (OLD.status='pending' AND NEW.status IN ('confirmed','cancelled')) OR
    (OLD.status='confirmed' AND NEW.status IN ('in_production','dispatched','cancelled')) OR
    (OLD.status='in_production' AND NEW.status IN ('dispatched','cancelled')) OR
    (OLD.status='dispatched' AND NEW.status='delivered') OR
    (OLD.status='paid' AND NEW.status IN ('dispatched','delivered'))
  ) THEN RAISE EXCEPTION 'Illegal order transition: % -> %',OLD.status,NEW.status; END IF;
  IF NEW.status='confirmed' AND OLD.status='pending' THEN
    IF NOT EXISTS(SELECT 1 FROM public.order_items WHERE order_id=NEW.id) THEN
      RAISE EXCEPTION 'Cannot confirm an empty order'; END IF;
    IF OLD.fulfillment_mode='made_to_order' AND NEW.amount_paid<NEW.deposit_required THEN
      RAISE EXCEPTION 'Minimum 50%% deposit is required before confirming this production order';
    END IF;
  END IF;
  IF NEW.status='dispatched' AND OLD.status<>'dispatched'
      AND NEW.fulfillment_mode='made_to_order' THEN
    SELECT COUNT(*),COALESCE(SUM(pr.weight_kg),0) INTO v_rolls,v_weight
    FROM public.product_rolls pr JOIN public.order_items oi ON oi.id=pr.order_item_id
    WHERE oi.order_id=NEW.id AND pr.status='sold';
    IF v_rolls<>NEW.production_rolls_requested OR v_weight<NEW.production_target_kg THEN
      RAISE EXCEPTION 'Allocate the requested physical rolls (at least % kg) before dispatch',NEW.production_target_kg;
    END IF;
  END IF;
  IF NEW.delivery_status<>OLD.delivery_status AND NOT (
    (OLD.delivery_status='pending' AND NEW.delivery_status='dispatched' AND NEW.status IN ('dispatched','paid')) OR
    (OLD.delivery_status='dispatched' AND NEW.delivery_status='delivered' AND NEW.status IN ('delivered','paid'))
  ) THEN RAISE EXCEPTION 'Illegal delivery transition'; END IF;
  IF NEW.status IN ('pending','cancelled') AND NEW.delivery_status<>'pending' THEN
    RAISE EXCEPTION 'Pending/cancelled orders cannot be dispatched'; END IF;
  IF NEW.status='cancelled' AND OLD.status<>'cancelled' AND OLD.amount_paid>0 THEN
    RAISE EXCEPTION 'Refund all payments before cancellation'; END IF;
  RETURN NEW;
END; $$;

-- Do not debit imaginary stock on confirmation of a made-to-order request.
-- Physical output gets credited normally by the production posting RPC;
-- the sale is debited exactly once when actual rolls are allocated later.
CREATE OR REPLACE FUNCTION public.process_order_confirmation()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_item record; v_stock numeric; v_qty numeric;
BEGIN
  IF OLD.status='pending' AND NEW.status='confirmed' THEN
    NEW.confirmed_at=now();
    IF NEW.fulfillment_mode='made_to_order' THEN RETURN NEW; END IF;
    FOR v_item IN SELECT oi.id,oi.finished_good_id,oi.quantity,fg.unit,fg.product_name,
      (SELECT COUNT(*) FROM public.product_rolls pr WHERE pr.order_item_id=oi.id AND pr.status='reserved') AS roll_count
      FROM public.order_items oi JOIN public.finished_goods fg ON fg.id=oi.finished_good_id
      WHERE oi.order_id=NEW.id ORDER BY oi.finished_good_id LOOP
      IF v_item.unit='rolls' AND v_item.roll_count=0 THEN
        RAISE EXCEPTION 'Roll product % has no allocated physical rolls',v_item.product_name; END IF;
      v_qty:=CASE WHEN v_item.unit='rolls' THEN v_item.roll_count ELSE v_item.quantity END;
      SELECT current_stock INTO v_stock FROM public.finished_goods WHERE id=v_item.finished_good_id FOR UPDATE;
      IF v_stock<v_qty THEN RAISE EXCEPTION 'Insufficient stock for %',v_item.product_name; END IF;
      UPDATE public.finished_goods SET current_stock=current_stock-v_qty WHERE id=v_item.finished_good_id;
      PERFORM public.record_stock_movement('finished',v_item.finished_good_id,'out',v_qty,
        'sale',NEW.id,'Order confirmed: '||NEW.order_number);
    END LOOP;
  END IF;
  RETURN NEW;
END; $$;

-- Inventory allocation is restricted to sales. This binds exact produced rolls
-- to the order and debits stock just once, under row locks, transactionally.
CREATE OR REPLACE FUNCTION public.allocate_production_order_rolls(p_order uuid,p_roll_ids uuid[])
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_order public.orders%ROWTYPE; v_line public.order_items%ROWTYPE;
        v_count integer; v_weight numeric; v_stock numeric;
BEGIN
  IF auth.uid() IS NULL OR public.get_user_role() NOT IN ('admin','sales_staff') THEN
    RAISE EXCEPTION 'Sales permission required' USING ERRCODE='42501'; END IF;
  SELECT * INTO v_order FROM public.orders WHERE id=p_order FOR UPDATE;
  IF NOT FOUND OR v_order.fulfillment_mode<>'made_to_order' OR
       v_order.status NOT IN ('confirmed','in_production') THEN
    RAISE EXCEPTION 'A confirmed production order is required'; END IF;
  SELECT * INTO v_line FROM public.order_items WHERE order_id=p_order;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order line not found'; END IF;
  IF EXISTS(SELECT 1 FROM public.product_rolls WHERE order_item_id=v_line.id) THEN
    RAISE EXCEPTION 'Rolls are already allocated to this order'; END IF;
  IF p_roll_ids IS NULL OR cardinality(p_roll_ids)<>v_order.production_rolls_requested
    OR (SELECT COUNT(DISTINCT r) FROM unnest(p_roll_ids) r)<>cardinality(p_roll_ids) THEN
    RAISE EXCEPTION 'Select exactly % different rolls',v_order.production_rolls_requested;
  END IF;
  SELECT COUNT(*),COALESCE(SUM(pr.weight_kg),0) INTO v_count,v_weight
  FROM (SELECT * FROM public.product_rolls WHERE id=ANY(p_roll_ids)
        ORDER BY id FOR UPDATE) pr
  WHERE pr.finished_good_id=v_line.finished_good_id AND pr.status='available';
  IF v_count<>v_order.production_rolls_requested OR v_weight<v_order.production_target_kg THEN
    RAISE EXCEPTION 'Selected rolls must be available and total at least % kg',v_order.production_target_kg;
  END IF;
  SELECT current_stock INTO v_stock FROM public.finished_goods WHERE id=v_line.finished_good_id FOR UPDATE;
  IF v_stock<v_count THEN RAISE EXCEPTION 'Insufficient aggregate inventory; reconcile stock'; END IF;
  UPDATE public.product_rolls SET order_item_id=v_line.id,status='sold' WHERE id=ANY(p_roll_ids);
  UPDATE public.finished_goods SET current_stock=current_stock-v_count WHERE id=v_line.finished_good_id;
  PERFORM public.record_stock_movement('finished',v_line.finished_good_id,'out',v_count,
     'sale',p_order,'Made-to-order physical rolls allocated');
END; $$;
REVOKE ALL ON FUNCTION public.allocate_production_order_rolls(uuid,uuid[]) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.allocate_production_order_rolls(uuid,uuid[]) TO authenticated;

-- On cancellation restore only stock that was ACTUALLY allocated. A production
-- order cancelled before physical allocation has no inventory movement.
CREATE OR REPLACE FUNCTION public.restore_cancelled_order()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_row record; v_count integer; v_qty numeric;
BEGIN
  IF NEW.status='cancelled' AND OLD.status IN ('confirmed','in_production') THEN
    FOR v_row IN SELECT oi.id,oi.finished_good_id,oi.quantity,fg.unit
      FROM public.order_items oi JOIN public.finished_goods fg ON fg.id=oi.finished_good_id
      WHERE oi.order_id=NEW.id ORDER BY oi.finished_good_id LOOP
      SELECT COUNT(*) INTO v_count FROM public.product_rolls
        WHERE order_item_id=v_row.id AND status='sold';
      IF OLD.fulfillment_mode='made_to_order' THEN
        IF v_count=0 THEN CONTINUE; END IF;
        v_qty:=v_count;
      ELSE
        IF v_row.unit='rolls' AND v_count=0 THEN
          RAISE EXCEPTION 'Roll allocation missing; reconcile before cancellation'; END IF;
        v_qty:=CASE WHEN v_row.unit='rolls' THEN v_count ELSE v_row.quantity END;
      END IF;
      UPDATE public.finished_goods SET current_stock=current_stock+v_qty WHERE id=v_row.finished_good_id;
      PERFORM public.record_stock_movement('finished',v_row.finished_good_id,'in',v_qty,
        'sale',NEW.id,'Cancelled order: physical stock returned');
    END LOOP;
    UPDATE public.product_rolls SET status='available',order_item_id=NULL
      WHERE order_item_id IN (SELECT id FROM public.order_items WHERE order_id=NEW.id)
        AND status='sold';
  END IF;
  RETURN NEW;
END; $$;

-- Allow a verified advance deposit on only an eligible pending production order.
CREATE OR REPLACE FUNCTION public.process_payment()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_order public.orders%ROWTYPE;
BEGIN
  SELECT * INTO v_order FROM public.orders WHERE id=NEW.order_id FOR UPDATE;
  IF NOT FOUND OR v_order.status='cancelled'
    OR (v_order.status='pending' AND (v_order.fulfillment_mode<>'made_to_order'
      OR v_order.deposit_required<=0)) THEN
    RAISE EXCEPTION 'Order cannot accept payments at this stage'; END IF;
  IF NEW.amount>v_order.balance_due THEN RAISE EXCEPTION 'Payment exceeds outstanding balance'; END IF;
  UPDATE public.orders SET amount_paid=amount_paid+NEW.amount,
    payment_status=CASE WHEN amount_paid+NEW.amount>=total THEN 'paid' ELSE 'partial' END
    WHERE id=NEW.order_id;
  RETURN NEW;
END; $$;

-- Hard guarantee: the provider-verified amount is settled exactly once and is
-- accepted on pending orders ONLY when the payment attempt is a deposit.
ALTER TABLE public.payment_attempts ADD COLUMN payment_kind text NOT NULL DEFAULT 'balance'
  CHECK (payment_kind IN ('balance','deposit'));
ALTER TABLE public.payment_attempts ADD COLUMN authorization_url text;
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_pending_deposit_attempt
  ON public.payment_attempts(order_id) WHERE status='pending' AND payment_kind='deposit';

CREATE OR REPLACE FUNCTION public.settle_verified_paystack(p_reference text,p_provider_id text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_attempt public.payment_attempts%ROWTYPE; v_order public.orders%ROWTYPE;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Service role required'; END IF;
  SELECT * INTO v_attempt FROM public.payment_attempts WHERE reference=p_reference FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Unknown payment attempt'; END IF;
  IF v_attempt.status='paid' THEN
    IF v_attempt.provider_transaction_id=p_provider_id THEN RETURN FALSE; END IF;
    RAISE EXCEPTION 'Payment reference has conflicting provider transaction';
  END IF;
  SELECT * INTO v_order FROM public.orders WHERE id=v_attempt.order_id FOR UPDATE;
  IF v_order.status='cancelled' OR v_order.balance_due<v_attempt.amount THEN
    RAISE EXCEPTION 'Order not eligible for settlement'; END IF;
  IF v_order.status='pending' AND NOT (
      v_order.fulfillment_mode='made_to_order' AND v_attempt.payment_kind='deposit'
      AND v_order.deposit_required>v_order.amount_paid
      AND v_attempt.amount=v_order.deposit_required-v_order.amount_paid) THEN
    RAISE EXCEPTION 'This order cannot accept an advance payment'; END IF;
  UPDATE public.payment_attempts
    SET status='paid',provider_transaction_id=p_provider_id,settled_at=now()
    WHERE id=v_attempt.id;
  INSERT INTO public.payments(order_id,amount,payment_method,paystack_reference,notes)
    VALUES(v_attempt.order_id,v_attempt.amount,'paystack',p_reference,
      'Verified Paystack '||v_attempt.payment_kind||' payment '||p_provider_id);
  RETURN TRUE;
END; $$;
REVOKE ALL ON FUNCTION public.settle_verified_paystack(text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.settle_verified_paystack(text,text) TO service_role;

-- Custom production orders are visible to existing customer + sales RLS
-- through their parent orders and order items; no cross-company table access.
NOTIFY pgrst, 'reload schema';
