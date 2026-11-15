-- FactoryFlow release hardening. Apply after 016. Review DEPLOYMENT.md before production deployment.
-- Everything in an RPC is a single Postgres transaction; any exception rolls back all writes.

-- Public signup cannot select a privileged role, even when it supplies forged user_metadata.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  INSERT INTO public.profiles (id, email, full_name, role)
  VALUES (NEW.id, NEW.email, COALESCE(NULLIF(NEW.raw_user_meta_data->>'full_name',''), NEW.email), 'customer');
  INSERT INTO public.customers (owner_profile_id, name, business_name, contact_phone, contact_email, address, approval_status)
  VALUES (NEW.id, COALESCE(NULLIF(NEW.raw_user_meta_data->>'full_name',''),NEW.email),
          NEW.raw_user_meta_data->>'business_name', NEW.raw_user_meta_data->>'contact_phone',
          NEW.email, NEW.raw_user_meta_data->>'address', 'pending');
  RETURN NEW;
END; $$;

-- Protect authorization fields even from an account's own profile UPDATE policy.
REVOKE UPDATE ON public.profiles FROM anon, authenticated;
GRANT UPDATE (full_name) ON public.profiles TO authenticated;

-- Only administrators may activate staff and grant roles. A self-signup remains a customer
-- until explicitly approved/promoted by an existing administrator.
CREATE OR REPLACE FUNCTION public.admin_set_staff_role(p_user UUID, p_role user_role)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_profile profiles%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR get_user_role() <> 'admin' THEN RAISE EXCEPTION 'Administrator required'; END IF;
  IF p_role NOT IN ('staff','sales_staff','hr_officer','production_supervisor') THEN
    RAISE EXCEPTION 'Staff role required'; END IF;
  SELECT * INTO v_profile FROM profiles WHERE id=p_user FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Account not found'; END IF;
  IF v_profile.role='customer' AND EXISTS (
    SELECT 1 FROM orders o JOIN customers c ON c.id=o.customer_id WHERE c.owner_profile_id=p_user
  ) THEN RAISE EXCEPTION 'Cannot convert a customer account that has placed orders'; END IF;
  UPDATE profiles SET role=p_role WHERE id=p_user;
  INSERT INTO employees(profile_id, full_name, role_title, contact_email, hire_date)
  SELECT p_user, COALESCE(v_profile.full_name,v_profile.email), INITCAP(REPLACE(p_role::text,'_',' ')), v_profile.email, CURRENT_DATE
  WHERE NOT EXISTS (SELECT 1 FROM employees WHERE profile_id=p_user);
  -- Remove unused customer shell created by the safe public-signup trigger.
  DELETE FROM customers WHERE owner_profile_id=p_user AND NOT EXISTS(
    SELECT 1 FROM orders WHERE customer_id=customers.id);
END; $$;
REVOKE ALL ON FUNCTION public.admin_set_staff_role(UUID,user_role) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.admin_set_staff_role(UUID,user_role) TO authenticated;

-- Lock down movement/payment/production tables: only controlled RPCs and triggers may post.
REVOKE INSERT, UPDATE, DELETE ON public.stock_movements, public.production_runs,
  public.production_run_materials, public.product_rolls, public.orders, public.order_items,
  public.payments FROM anon, authenticated;
-- Supabase client users retain SELECT subject to their RLS policies.

-- Helpers are called internally by trusted triggers; never directly by the browser.
REVOKE ALL ON FUNCTION public.record_stock_movement(TEXT,UUID,stock_movement_type,NUMERIC,stock_source,UUID,TEXT) FROM PUBLIC,anon,authenticated;
ALTER FUNCTION public.record_stock_movement(TEXT,UUID,stock_movement_type,NUMERIC,stock_source,UUID,TEXT) SET search_path = public;
ALTER FUNCTION public.adjust_stock(TEXT,UUID,NUMERIC,stock_movement_type,TEXT) SET search_path = public;
REVOKE ALL ON FUNCTION public.adjust_stock(TEXT,UUID,NUMERIC,stock_movement_type,TEXT) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.adjust_stock(TEXT,UUID,NUMERIC,stock_movement_type,TEXT) TO authenticated;
CREATE OR REPLACE FUNCTION public.adjust_stock(p_material_type TEXT,p_material_id UUID,
  p_quantity NUMERIC,p_movement_type stock_movement_type,p_reason TEXT)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_stock NUMERIC; v_unit output_unit;
BEGIN
  IF get_user_role() NOT IN ('admin','production_supervisor') OR auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Insufficient permissions for stock adjustment'; END IF;
  IF p_quantity IS NULL OR p_quantity <= 0 OR p_quantity > 100000000 THEN RAISE EXCEPTION 'Invalid quantity'; END IF;
  IF LENGTH(TRIM(COALESCE(p_reason,''))) < 5 THEN RAISE EXCEPTION 'A reason (minimum 5 characters) is required'; END IF;
  IF p_material_type='raw' THEN
    SELECT current_stock INTO v_stock FROM raw_materials WHERE id=p_material_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Raw material not found'; END IF;
    IF p_movement_type='out' AND v_stock < p_quantity THEN RAISE EXCEPTION 'Insufficient stock'; END IF;
    UPDATE raw_materials SET current_stock=current_stock+(CASE WHEN p_movement_type='in' THEN p_quantity ELSE -p_quantity END),
      last_restock_date=CASE WHEN p_movement_type='in' AND p_reason ILIKE '%restock%' THEN CURRENT_DATE ELSE last_restock_date END WHERE id=p_material_id;
  ELSIF p_material_type='finished' THEN
    SELECT current_stock,unit INTO v_stock,v_unit FROM finished_goods WHERE id=p_material_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Finished good not found'; END IF;
    IF v_unit='rolls' THEN RAISE EXCEPTION 'Individual rolls must be reconciled by physical roll ID; manual aggregate changes are disabled'; END IF;
    IF p_movement_type='out' AND v_stock<p_quantity THEN RAISE EXCEPTION 'Insufficient stock'; END IF;
    UPDATE finished_goods SET current_stock=current_stock+(CASE WHEN p_movement_type='in' THEN p_quantity ELSE -p_quantity END) WHERE id=p_material_id;
  ELSE RAISE EXCEPTION 'Invalid material type'; END IF;
  PERFORM record_stock_movement(p_material_type,p_material_id,p_movement_type,p_quantity,
    CASE WHEN p_reason ILIKE '%restock%' THEN 'restock'::stock_source ELSE 'manual_adjustment'::stock_source END,NULL,p_reason);
END; $$;

-- Direct edits of posted records would invalidate stock accounting.
CREATE OR REPLACE FUNCTION public.reject_posted_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN RAISE EXCEPTION 'Posted records are immutable; use a reversal or new transaction'; END; $$;
CREATE TRIGGER trg_production_immutable BEFORE UPDATE OR DELETE ON public.production_runs
  FOR EACH ROW EXECUTE FUNCTION public.reject_posted_mutation();
CREATE TRIGGER trg_production_materials_immutable BEFORE UPDATE OR DELETE ON public.production_run_materials
  FOR EACH ROW EXECUTE FUNCTION public.reject_posted_mutation();
CREATE TRIGGER trg_payment_immutable BEFORE UPDATE OR DELETE ON public.payments
  FOR EACH ROW EXECUTE FUNCTION public.reject_posted_mutation();
CREATE TRIGGER trg_stock_movement_immutable BEFORE UPDATE OR DELETE ON public.stock_movements
  FOR EACH ROW EXECUTE FUNCTION public.reject_posted_mutation();

-- Guard order items inside the database, not only in the UI. A parent-row lock
-- prevents a concurrent confirm/edit race.
CREATE OR REPLACE FUNCTION public.guard_order_items()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_status order_status; v_order UUID;
BEGIN
  v_order:=CASE WHEN TG_OP='DELETE' THEN OLD.order_id ELSE NEW.order_id END;
  SELECT status INTO v_status FROM orders WHERE id=v_order FOR UPDATE;
  IF v_status IS DISTINCT FROM 'pending' THEN RAISE EXCEPTION 'Only pending orders can be edited'; END IF;
  IF TG_OP='UPDATE' AND NEW.order_id<>OLD.order_id THEN RAISE EXCEPTION 'Moving items between orders is forbidden'; END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END; $$;
CREATE TRIGGER trg_guard_order_items BEFORE INSERT OR UPDATE OR DELETE ON public.order_items
  FOR EACH ROW EXECUTE FUNCTION public.guard_order_items();

-- Validate order transitions BEFORE the inventory deduction trigger fires.
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS payment_status TEXT NOT NULL DEFAULT 'unpaid'
  CHECK (payment_status IN ('unpaid','partial','paid','refunded'));
UPDATE public.orders SET payment_status=CASE
  WHEN amount_paid=0 THEN 'unpaid' WHEN amount_paid>=total AND total>0 THEN 'paid' ELSE 'partial' END;
ALTER TABLE public.orders ADD CONSTRAINT orders_amount_paid_valid CHECK (amount_paid>=0 AND amount_paid<=total);
CREATE OR REPLACE FUNCTION public.guard_order_transition()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.customer_id<>OLD.customer_id THEN RAISE EXCEPTION 'Order owner is immutable'; END IF;
  IF NEW.status<>OLD.status AND NOT (
    (OLD.status='pending' AND NEW.status IN ('confirmed','cancelled')) OR
    (OLD.status='confirmed' AND NEW.status IN ('in_production','dispatched','cancelled')) OR
    (OLD.status='in_production' AND NEW.status IN ('dispatched','cancelled')) OR
    (OLD.status='dispatched' AND NEW.status='delivered') OR
    (OLD.status='paid' AND NEW.status IN ('dispatched','delivered'))
  ) THEN RAISE EXCEPTION 'Illegal order transition: % -> %',OLD.status,NEW.status; END IF;
  IF NEW.status='confirmed' AND OLD.status='pending'
     AND NOT EXISTS(SELECT 1 FROM order_items WHERE order_id=NEW.id) THEN
    RAISE EXCEPTION 'Cannot confirm an empty order'; END IF;
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
CREATE TRIGGER trg_aaa_guard_order_transition BEFORE UPDATE ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.guard_order_transition();

-- Payments do not skip inventory confirmation or change the fulfillment state.
CREATE OR REPLACE FUNCTION public.process_payment()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_order orders%ROWTYPE;
BEGIN
  SELECT * INTO v_order FROM orders WHERE id=NEW.order_id FOR UPDATE;
  IF NOT FOUND OR v_order.status IN ('pending','cancelled') THEN RAISE EXCEPTION 'Order must be confirmed before payment'; END IF;
  IF NEW.amount>v_order.balance_due THEN RAISE EXCEPTION 'Payment exceeds outstanding balance'; END IF;
  UPDATE orders SET amount_paid=amount_paid+NEW.amount,
    payment_status=CASE WHEN amount_paid+NEW.amount>=total THEN 'paid' ELSE 'partial' END
  WHERE id=NEW.order_id;
  RETURN NEW;
END; $$;

-- Reverse stock on pre-dispatch cancellation; retain immutable movement history.
CREATE OR REPLACE FUNCTION public.restore_cancelled_order()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_row RECORD; v_count INTEGER; v_qty NUMERIC;
BEGIN
  IF NEW.status='cancelled' AND OLD.status IN ('confirmed','in_production') THEN
    FOR v_row IN SELECT oi.id,oi.finished_good_id,oi.quantity,fg.unit
      FROM order_items oi JOIN finished_goods fg ON fg.id=oi.finished_good_id
      WHERE oi.order_id=NEW.id ORDER BY oi.finished_good_id LOOP
      SELECT count(*) INTO v_count FROM product_rolls WHERE order_item_id=v_row.id;
      IF v_row.unit='rolls' AND v_count=0 THEN RAISE EXCEPTION 'Roll allocation missing; reconcile before cancellation'; END IF;
      v_qty:=CASE WHEN v_row.unit='rolls' THEN v_count ELSE v_row.quantity END;
      UPDATE finished_goods SET current_stock=current_stock+v_qty WHERE id=v_row.finished_good_id;
      PERFORM record_stock_movement('finished',v_row.finished_good_id,'in',v_qty,'sale',NEW.id,'Cancelled order: stock returned');
    END LOOP;
    UPDATE product_rolls SET status='available',order_item_id=NULL
      WHERE order_item_id IN (SELECT id FROM order_items WHERE order_id=NEW.id) AND status='sold';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER trg_restore_cancelled_order AFTER UPDATE OF status ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.restore_cancelled_order();

-- Fix the original roll reservation trigger: rolls sell ONLY at confirmation;
-- pending cancellation releases reservations. Also enforce no partial/no allocation.
CREATE OR REPLACE FUNCTION public.sync_rolls_with_order_status()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF OLD.status='pending' AND NEW.status='confirmed' THEN
    UPDATE product_rolls SET status='sold'
      WHERE status='reserved' AND order_item_id IN (SELECT id FROM order_items WHERE order_id=NEW.id);
  ELSIF OLD.status='pending' AND NEW.status='cancelled' THEN
    UPDATE product_rolls SET status='available',order_item_id=NULL
      WHERE status='reserved' AND order_item_id IN (SELECT id FROM order_items WHERE order_id=NEW.id);
  END IF;
  RETURN NEW;
END; $$;

-- Reject legacy roll lines without physical roll allocations and prevent double-stock debit.
CREATE OR REPLACE FUNCTION public.process_order_confirmation()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_item RECORD; v_stock NUMERIC; v_qty NUMERIC;
BEGIN
  IF OLD.status='pending' AND NEW.status='confirmed' THEN
    NEW.confirmed_at=now();
    FOR v_item IN SELECT oi.id, oi.finished_good_id, oi.quantity, fg.unit, fg.product_name,
      (SELECT COUNT(*) FROM product_rolls pr WHERE pr.order_item_id=oi.id AND pr.status='reserved') AS roll_count
      FROM order_items oi JOIN finished_goods fg ON fg.id=oi.finished_good_id
      WHERE oi.order_id=NEW.id ORDER BY oi.finished_good_id LOOP
      IF v_item.unit='rolls' AND v_item.roll_count=0 THEN
        RAISE EXCEPTION 'Roll product % has no allocated physical rolls',v_item.product_name; END IF;
      v_qty:=CASE WHEN v_item.unit='rolls' THEN v_item.roll_count ELSE v_item.quantity END;
      SELECT current_stock INTO v_stock FROM finished_goods WHERE id=v_item.finished_good_id FOR UPDATE;
      IF v_stock<v_qty THEN RAISE EXCEPTION 'Insufficient stock for %',v_item.product_name; END IF;
      UPDATE finished_goods SET current_stock=current_stock-v_qty WHERE id=v_item.finished_good_id;
      PERFORM record_stock_movement('finished',v_item.finished_good_id,'out',v_qty,'sale',NEW.id,'Order confirmed: '||NEW.order_number);
    END LOOP;
  END IF;
  RETURN NEW;
END; $$;

-- Production posting: validates material formula and posts run + all materials atomically.
CREATE OR REPLACE FUNCTION public.post_production_run(p_run JSONB,p_materials JSONB DEFAULT '[]'::jsonb)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_run UUID; v_stage machine_stage; v_material JSONB; v_count INTEGER :=0; v_rec production_runs%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR get_user_role() NOT IN ('admin','production_supervisor') THEN
    RAISE EXCEPTION 'Production posting requires production supervisor'; END IF;
  IF jsonb_typeof(p_run) IS DISTINCT FROM 'object' OR jsonb_typeof(p_materials) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Invalid production payload'; END IF;
  SELECT stage INTO v_stage FROM machines WHERE id=(p_run->>'machine_id')::uuid AND is_active;
  IF v_stage IS NULL THEN RAISE EXCEPTION 'Select an active machine'; END IF;
  IF v_stage<>'conversion' AND jsonb_array_length(p_materials)=0 THEN
    RAISE EXCEPTION 'Extrusion run must include material consumption'; END IF;
  IF v_stage='conversion' AND jsonb_array_length(p_materials)>0 THEN
    RAISE EXCEPTION 'Conversion run cannot consume raw formula lines'; END IF;
  IF (p_run->>'output_quantity')::numeric<=0 AND COALESCE(jsonb_array_length(p_run->'roll_weights'),0)=0 THEN
    RAISE EXCEPTION 'Output must be positive'; END IF;
  -- Explicit columns retain table DEFAULTs and prevent forged IDs / authors.
  v_rec:=jsonb_populate_record(NULL::production_runs,p_run);
  INSERT INTO production_runs (run_date,shift,machine_id,operator_name,finished_good_id,film_thickness,film_width,film_color,output_quantity,output_unit,input_product_id,input_quantity_consumed,supervisor_name,process_type,formula_code,roll_count,roll_length,avg_weight_per_roll,start_time,end_time,total_runtime_hours,downtime_hours,temp_z1,temp_z2,temp_z3,temp_z4,temp_z5,temp_z6,screw_speed_rpm,line_speed_mpm,cut_length_mm,bottom_seal_offset_mm,cutting_speed_cpm,print_colours_count,print_speed,print_tension,cleaned_rollers,roll_edges_ok,neatness_rating,samples_tested,samples_passed,samples_failed,qc_issues,qc_issue_other,batch_id,quality_grade,waste_quantity,notes,roll_weights,created_by)
  VALUES (COALESCE(v_rec.run_date,CURRENT_DATE),v_rec.shift,v_rec.machine_id,v_rec.operator_name,v_rec.finished_good_id,v_rec.film_thickness,v_rec.film_width,v_rec.film_color,v_rec.output_quantity,COALESCE(v_rec.output_unit,'kg'::output_unit),v_rec.input_product_id,COALESCE(v_rec.input_quantity_consumed,0),v_rec.supervisor_name,v_rec.process_type,v_rec.formula_code,v_rec.roll_count,v_rec.roll_length,v_rec.avg_weight_per_roll,v_rec.start_time,v_rec.end_time,v_rec.total_runtime_hours,COALESCE(v_rec.downtime_hours,0),v_rec.temp_z1,v_rec.temp_z2,v_rec.temp_z3,v_rec.temp_z4,v_rec.temp_z5,v_rec.temp_z6,v_rec.screw_speed_rpm,v_rec.line_speed_mpm,v_rec.cut_length_mm,v_rec.bottom_seal_offset_mm,v_rec.cutting_speed_cpm,v_rec.print_colours_count,v_rec.print_speed,v_rec.print_tension,v_rec.cleaned_rollers,v_rec.roll_edges_ok,v_rec.neatness_rating,v_rec.samples_tested,v_rec.samples_passed,v_rec.samples_failed,v_rec.qc_issues,v_rec.qc_issue_other,v_rec.batch_id,v_rec.quality_grade,COALESCE(v_rec.waste_quantity,0),v_rec.notes,v_rec.roll_weights,auth.uid()) RETURNING id INTO v_run;
  FOR v_material IN SELECT * FROM jsonb_array_elements(p_materials) LOOP
    IF (v_material->>'quantity_kg')::numeric<=0 THEN RAISE EXCEPTION 'Invalid material quantity'; END IF;
    INSERT INTO production_run_materials(production_run_id,raw_material_id,quantity_kg,proportion_pct)
    VALUES(v_run,(v_material->>'raw_material_id')::uuid,(v_material->>'quantity_kg')::numeric,
      (v_material->>'proportion_pct')::numeric);
    v_count:=v_count+1;
  END LOOP;
  RETURN v_run;
END; $$;
REVOKE ALL ON FUNCTION public.post_production_run(JSONB,JSONB) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.post_production_run(JSONB,JSONB) TO authenticated;

-- Shared locked atomic customer order save. Existing order may be edited ONLY while pending.
CREATE OR REPLACE FUNCTION public.save_customer_order(p_existing_order UUID,p_delivery_date DATE,
  p_notes TEXT,p_items JSONB,p_roll_ids UUID[])
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_customer UUID; v_order UUID; v_line JSONB; v_fg UUID; v_qty NUMERIC;
  v_group RECORD; v_item UUID; v_roll_ids UUID[]:=COALESCE(p_roll_ids,ARRAY[]::uuid[]); v_found INT;
BEGIN
  IF auth.uid() IS NULL OR get_user_role()<>'customer' THEN RAISE EXCEPTION 'Customer required'; END IF;
  SELECT id INTO v_customer FROM customers WHERE owner_profile_id=auth.uid() AND approval_status='approved';
  IF v_customer IS NULL THEN RAISE EXCEPTION 'Company approval required'; END IF;
  IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Products must be an array'; END IF;
  IF jsonb_array_length(p_items)=0 AND cardinality(v_roll_ids)=0 THEN RAISE EXCEPTION 'Order must contain items'; END IF;
  IF cardinality(v_roll_ids)<>COALESCE((SELECT COUNT(DISTINCT x) FROM unnest(v_roll_ids) x),0) THEN
    RAISE EXCEPTION 'Duplicate roll selections'; END IF;
  IF p_existing_order IS NULL THEN
    INSERT INTO orders(customer_id,delivery_date,notes,created_by,status)
    VALUES(v_customer,p_delivery_date,p_notes,auth.uid(),'pending') RETURNING id INTO v_order;
  ELSE
    SELECT id INTO v_order FROM orders WHERE id=p_existing_order AND customer_id=v_customer AND status='pending' FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Only your pending orders can be edited'; END IF;
    DELETE FROM order_items WHERE order_id=v_order;
    UPDATE orders SET delivery_date=p_delivery_date,notes=p_notes WHERE id=v_order;
  END IF;
  FOR v_line IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_fg:=(v_line->>'finished_good_id')::uuid; v_qty:=(v_line->>'quantity')::numeric;
    IF v_qty IS NULL OR v_qty<=0 THEN RAISE EXCEPTION 'Invalid product quantity'; END IF;
    IF NOT EXISTS(SELECT 1 FROM finished_goods WHERE id=v_fg AND unit<>'rolls'
      AND customer_orderable AND unit_price IS NOT NULL AND (customer_id IS NULL OR customer_id=v_customer))
      THEN RAISE EXCEPTION 'Product is unavailable'; END IF;
    INSERT INTO order_items(order_id,finished_good_id,quantity) VALUES(v_order,v_fg,v_qty);
  END LOOP;
  IF cardinality(v_roll_ids)>0 THEN
    SELECT COUNT(*) INTO v_found FROM (
      SELECT pr.id FROM product_rolls pr JOIN finished_goods fg ON fg.id=pr.finished_good_id
      WHERE pr.id=ANY(v_roll_ids) AND pr.status='available' AND fg.unit='rolls'
       AND fg.customer_orderable AND fg.unit_price IS NOT NULL
       AND (fg.customer_id IS NULL OR fg.customer_id=v_customer) FOR UPDATE OF pr
    ) q;
    IF v_found<>cardinality(v_roll_ids) THEN RAISE EXCEPTION 'Some selected rolls are unavailable'; END IF;
    PERFORM set_config('app.roll_order','on',true);
    FOR v_group IN SELECT finished_good_id,SUM(weight_kg) qty,
      CASE WHEN COUNT(DISTINCT micron)=1 THEN MAX(micron) ELSE NULL END micron,ARRAY_AGG(id) ids
      FROM product_rolls WHERE id=ANY(v_roll_ids) GROUP BY finished_good_id LOOP
      INSERT INTO order_items(order_id,finished_good_id,quantity,specified_micron)
        VALUES(v_order,v_group.finished_good_id,v_group.qty,v_group.micron) RETURNING id INTO v_item;
      UPDATE product_rolls SET status='reserved',order_item_id=v_item WHERE id=ANY(v_group.ids);
    END LOOP;
    PERFORM set_config('app.roll_order','off',true);
  END IF;
  RETURN v_order;
END; $$;
REVOKE ALL ON FUNCTION public.save_customer_order(UUID,DATE,TEXT,JSONB,UUID[]) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.save_customer_order(UUID,DATE,TEXT,JSONB,UUID[]) TO authenticated;
CREATE OR REPLACE FUNCTION public.place_customer_order(p_delivery_date DATE,p_notes TEXT,p_items JSONB,p_roll_ids UUID[])
RETURNS UUID LANGUAGE sql SECURITY DEFINER SET search_path=public AS $$
  SELECT public.save_customer_order(NULL::uuid,p_delivery_date,p_notes,p_items,p_roll_ids);
$$;
REVOKE ALL ON FUNCTION public.place_customer_order(DATE,TEXT,JSONB,UUID[]) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.place_customer_order(DATE,TEXT,JSONB,UUID[]) TO authenticated;

-- Staff order creation. Roll items MUST be selected by physical roll ID.
CREATE OR REPLACE FUNCTION public.create_staff_order(p_customer UUID,p_delivery_date DATE,
  p_notes TEXT,p_items JSONB,p_roll_ids UUID[] DEFAULT ARRAY[]::uuid[])
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_order UUID; v_line JSONB; v_fg UUID; v_price NUMERIC; v_qty NUMERIC;
  v_rolls UUID[]:=COALESCE(p_roll_ids,ARRAY[]::uuid[]); v_found INT; v_group RECORD; v_item UUID;
BEGIN
  IF auth.uid() IS NULL OR get_user_role() NOT IN ('admin','sales_staff') THEN RAISE EXCEPTION 'Sales permission required'; END IF;
  IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Invalid items'; END IF;
  IF jsonb_array_length(p_items)=0 AND cardinality(v_rolls)=0 THEN RAISE EXCEPTION 'At least one item required'; END IF;
  IF NOT EXISTS(SELECT 1 FROM customers WHERE id=p_customer) THEN RAISE EXCEPTION 'Customer not found'; END IF;
  IF cardinality(v_rolls)<>COALESCE((SELECT COUNT(DISTINCT id) FROM unnest(v_rolls) id),0) THEN
    RAISE EXCEPTION 'Duplicate roll selection'; END IF;
  INSERT INTO orders(customer_id,delivery_date,notes,created_by)
  VALUES(p_customer,p_delivery_date,p_notes,auth.uid()) RETURNING id INTO v_order;
  FOR v_line IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_fg:=(v_line->>'finished_good_id')::uuid;
    v_qty:=(v_line->>'quantity')::numeric;
    v_price:=(v_line->>'unit_price')::numeric;
    IF v_qty IS NULL OR v_qty<=0 OR v_price IS NULL OR v_price<0 THEN RAISE EXCEPTION 'Invalid line price/quantity'; END IF;
    IF NOT EXISTS(SELECT 1 FROM finished_goods WHERE id=v_fg AND unit<>'rolls') THEN
      RAISE EXCEPTION 'Roll goods must be allocated by physical roll ID'; END IF;
    INSERT INTO order_items(order_id,finished_good_id,quantity,unit_price,specified_micron)
      VALUES(v_order,v_fg,v_qty,v_price,(v_line->>'specified_micron')::numeric);
  END LOOP;
  IF cardinality(v_rolls)>0 THEN
    SELECT count(*) INTO v_found FROM (
      SELECT pr.id FROM product_rolls pr JOIN finished_goods fg ON fg.id=pr.finished_good_id
      WHERE pr.id=ANY(v_rolls) AND pr.status='available' AND fg.unit='rolls' AND fg.unit_price IS NOT NULL
      FOR UPDATE OF pr) q;
    IF v_found<>cardinality(v_rolls) THEN RAISE EXCEPTION 'Roll unavailable'; END IF;
    PERFORM set_config('app.roll_order','on',true);
    FOR v_group IN SELECT pr.finished_good_id,SUM(pr.weight_kg) qty,fg.unit_price,
      CASE WHEN COUNT(DISTINCT pr.micron)=1 THEN MAX(pr.micron) ELSE NULL END micron,ARRAY_AGG(pr.id) ids
      FROM product_rolls pr JOIN finished_goods fg ON fg.id=pr.finished_good_id
      WHERE pr.id=ANY(v_rolls) GROUP BY pr.finished_good_id,fg.unit_price LOOP
      INSERT INTO order_items(order_id,finished_good_id,quantity,unit_price,specified_micron)
        VALUES(v_order,v_group.finished_good_id,v_group.qty,v_group.unit_price,v_group.micron) RETURNING id INTO v_item;
      UPDATE product_rolls SET status='reserved',order_item_id=v_item WHERE id=ANY(v_group.ids);
    END LOOP;
    PERFORM set_config('app.roll_order','off',true);
  END IF;
  RETURN v_order;
END; $$;
REVOKE ALL ON FUNCTION public.create_staff_order(UUID,DATE,TEXT,JSONB,UUID[]) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.create_staff_order(UUID,DATE,TEXT,JSONB,UUID[]) TO authenticated;

-- Explicit workflow operations; no client-side UPDATE on orders.
CREATE OR REPLACE FUNCTION public.change_order_state(p_order UUID,p_action TEXT)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_order orders%ROWTYPE; v_customer UUID;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  SELECT * INTO v_order FROM orders WHERE id=p_order FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order not found'; END IF;
  IF get_user_role()='customer' THEN
    SELECT id INTO v_customer FROM customers WHERE owner_profile_id=auth.uid();
    IF v_order.customer_id IS DISTINCT FROM v_customer OR p_action<>'cancel' OR v_order.status<>'pending' THEN
      RAISE EXCEPTION 'Customers may only cancel their own pending orders'; END IF;
  ELSIF get_user_role() NOT IN ('admin','sales_staff') THEN RAISE EXCEPTION 'Sales role required'; END IF;
  CASE p_action
    WHEN 'confirm' THEN
      IF v_order.status<>'pending' THEN RAISE EXCEPTION 'Only pending orders can be confirmed'; END IF;
      UPDATE orders SET status='confirmed' WHERE id=p_order;
    WHEN 'dispatch' THEN
      IF v_order.status NOT IN ('confirmed','in_production','paid') OR v_order.delivery_status<>'pending' THEN
        RAISE EXCEPTION 'Order must be confirmed before dispatch'; END IF;
      UPDATE orders SET status='dispatched',delivery_status='dispatched' WHERE id=p_order;
    WHEN 'deliver' THEN
      IF v_order.status<>'dispatched' OR v_order.delivery_status<>'dispatched' THEN RAISE EXCEPTION 'Order must be dispatched'; END IF;
      UPDATE orders SET status='delivered',delivery_status='delivered' WHERE id=p_order;
    WHEN 'cancel' THEN
      IF v_order.status NOT IN ('pending','confirmed','in_production') OR v_order.amount_paid<>0 THEN
        RAISE EXCEPTION 'Refund payments first; dispatched orders require a return process'; END IF;
      IF EXISTS(SELECT 1 FROM payment_attempts WHERE order_id=p_order AND status='pending') THEN
        RAISE EXCEPTION 'A Paystack payment attempt is unresolved; reconcile it before cancellation'; END IF;
      UPDATE orders SET status='cancelled' WHERE id=p_order;
    ELSE RAISE EXCEPTION 'Unknown action';
  END CASE;
END; $$;
REVOKE ALL ON FUNCTION public.change_order_state(UUID,TEXT) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.change_order_state(UUID,TEXT) TO authenticated;

-- Payments: only staff-approved offline receipts are client invocable.
CREATE OR REPLACE FUNCTION public.record_offline_payment(p_order UUID,p_amount NUMERIC,p_method payment_method,p_notes TEXT)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_id UUID; v_order orders%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR get_user_role() NOT IN ('admin','sales_staff') THEN RAISE EXCEPTION 'Sales permission required'; END IF;
  IF p_method NOT IN ('cash','mobile_money','bank_transfer') THEN RAISE EXCEPTION 'Paystack must be verified server-side'; END IF;
  SELECT * INTO v_order FROM orders WHERE id=p_order FOR UPDATE;
  IF NOT FOUND OR v_order.status IN ('pending','cancelled') OR p_amount IS NULL OR p_amount<=0 OR p_amount>v_order.balance_due THEN
    RAISE EXCEPTION 'Invalid payment or order balance'; END IF;
  INSERT INTO payments(order_id,amount,payment_method,notes,recorded_by)
    VALUES(p_order,p_amount,p_method,LEFT(p_notes,1000),auth.uid()) RETURNING id INTO v_id;
  RETURN v_id;
END; $$;
REVOKE ALL ON FUNCTION public.record_offline_payment(UUID,NUMERIC,payment_method,TEXT) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.record_offline_payment(UUID,NUMERIC,payment_method,TEXT) TO authenticated;

-- Every Paystack checkout is initialized by the server; the callback must compare
-- provider ID, reference, currency, amount, order and verified status before settlement.
CREATE TABLE public.payment_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reference TEXT NOT NULL UNIQUE,
  order_id UUID NOT NULL REFERENCES orders(id),
  amount NUMERIC(12,2) NOT NULL CHECK(amount>0),
  currency TEXT NOT NULL DEFAULT 'GHS' CHECK(currency='GHS'),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','paid','failed')),
  provider_transaction_id TEXT UNIQUE,
  initiated_by UUID REFERENCES profiles(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_checked_at TIMESTAMPTZ,
  settled_at TIMESTAMPTZ
);
CREATE INDEX idx_payment_attempts_order ON public.payment_attempts(order_id,created_at DESC);
ALTER TABLE public.payment_attempts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Sales read payment attempts" ON public.payment_attempts FOR SELECT
  USING (get_user_role() IN ('admin','sales_staff'));
CREATE POLICY "Customer read own attempts" ON public.payment_attempts FOR SELECT
  USING (order_id IN (SELECT o.id FROM orders o JOIN customers c ON c.id=o.customer_id WHERE c.owner_profile_id=auth.uid()));
REVOKE INSERT,UPDATE,DELETE ON public.payment_attempts FROM anon,authenticated;

CREATE OR REPLACE FUNCTION public.settle_verified_paystack(p_reference TEXT,p_provider_id TEXT)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_attempt payment_attempts%ROWTYPE; v_order orders%ROWTYPE;
BEGIN
  -- Only the Edge Function's service-role connection may settle verified funds.
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Service role required'; END IF;
  SELECT * INTO v_attempt FROM payment_attempts WHERE reference=p_reference FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Unknown payment attempt'; END IF;
  IF v_attempt.status='paid' THEN
    IF v_attempt.provider_transaction_id=p_provider_id THEN RETURN FALSE; END IF;
    RAISE EXCEPTION 'Payment reference has conflicting provider transaction';
  END IF;
  SELECT * INTO v_order FROM orders WHERE id=v_attempt.order_id FOR UPDATE;
  IF v_order.status IN ('pending','cancelled') OR v_order.balance_due<v_attempt.amount THEN
    RAISE EXCEPTION 'Order not eligible for settlement'; END IF;
  UPDATE payment_attempts SET status='paid',provider_transaction_id=p_provider_id,settled_at=now()
    WHERE id=v_attempt.id;
  INSERT INTO payments(order_id,amount,payment_method,paystack_reference,notes)
    VALUES(v_attempt.order_id,v_attempt.amount,'paystack',p_reference,'Verified Paystack transaction '||p_provider_id);
  RETURN TRUE;
END; $$;
REVOKE ALL ON FUNCTION public.settle_verified_paystack(TEXT,TEXT) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.settle_verified_paystack(TEXT,TEXT) TO service_role;

-- Immutable refund ledger; verified provider refunds require a separate backend approval path.
CREATE TABLE public.payment_refunds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id UUID NOT NULL REFERENCES payments(id),
  amount NUMERIC(12,2) NOT NULL CHECK(amount>0),
  reason TEXT NOT NULL CHECK(length(trim(reason))>=5),
  refunded_by UUID REFERENCES profiles(id),
  provider_refund_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.payment_refunds ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Finance view refunds" ON public.payment_refunds FOR SELECT USING(get_user_role() IN ('admin','sales_staff'));
REVOKE INSERT,UPDATE,DELETE ON public.payment_refunds FROM anon,authenticated;
CREATE OR REPLACE FUNCTION public.refund_offline_payment(p_payment UUID,p_amount NUMERIC,p_reason TEXT)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_payment payments%ROWTYPE; v_paid NUMERIC; v_id UUID;
BEGIN
  IF auth.uid() IS NULL OR get_user_role()<>'admin' THEN RAISE EXCEPTION 'Administrator approval required'; END IF;
  SELECT * INTO v_payment FROM payments WHERE id=p_payment FOR UPDATE;
  IF NOT FOUND OR v_payment.payment_method='paystack' THEN RAISE EXCEPTION 'Paystack refunds require provider verification'; END IF;
  SELECT COALESCE(SUM(amount),0) INTO v_paid FROM payment_refunds WHERE payment_id=p_payment;
  IF p_amount IS NULL OR p_amount<=0 OR p_amount>v_payment.amount-v_paid OR length(trim(coalesce(p_reason,'')))<5 THEN
    RAISE EXCEPTION 'Invalid refund amount or reason'; END IF;
  UPDATE orders SET amount_paid=amount_paid-p_amount,
    payment_status=CASE WHEN amount_paid-p_amount<=0 THEN 'refunded' ELSE 'partial' END
    WHERE id=v_payment.order_id;
  INSERT INTO payment_refunds(payment_id,amount,reason,refunded_by)
    VALUES(p_payment,p_amount,p_reason,auth.uid()) RETURNING id INTO v_id;
  RETURN v_id;
END; $$;
REVOKE ALL ON FUNCTION public.refund_offline_payment(UUID,NUMERIC,TEXT) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.refund_offline_payment(UUID,NUMERIC,TEXT) TO authenticated;

-- Security constraints and indexes (no destructive data rewrite/backfill).
CREATE UNIQUE INDEX IF NOT EXISTS idx_customer_owner_unique ON public.customers(owner_profile_id) WHERE owner_profile_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_notifications_profile_created ON public.notifications(profile_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payments_created ON public.payments(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_customer_created ON public.orders(customer_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_product_rolls_status_no ON public.product_rolls(status,roll_no);
CREATE INDEX IF NOT EXISTS idx_production_run_material_raw ON public.production_run_materials(raw_material_id,production_run_id);
ALTER TABLE public.machine_downtime ADD CONSTRAINT downtime_valid_interval CHECK(end_time IS NULL OR end_time>=start_time);
ALTER TABLE public.leave_requests ADD CONSTRAINT leave_dates_valid CHECK(end_date>=start_date);
ALTER TABLE public.payroll_records ADD CONSTRAINT payroll_nonnegative CHECK(days_worked>=0 AND hours_worked>=0 AND gross_pay>=0 AND deductions>=0 AND deductions<=gross_pay);

-- Prevent staff forging inventory ledger via direct aggregate stock edits.
-- Roll aggregate inventory reconciliation must be performed after physical roll count.
CREATE OR REPLACE VIEW public.roll_stock_discrepancies WITH (security_invoker=true) AS
SELECT fg.id,fg.product_name,fg.current_stock AS recorded_stock,
  (SELECT count(*) FROM product_rolls pr WHERE pr.finished_good_id=fg.id AND pr.status<>'sold') AS counted_rolls
FROM finished_goods fg WHERE fg.unit='rolls'
  AND fg.current_stock <> (SELECT count(*) FROM product_rolls pr WHERE pr.finished_good_id=fg.id AND pr.status<>'sold');

-- Authorized users may edit catalog metadata, never hand-edit stock counters.
REVOKE UPDATE ON public.raw_materials, public.finished_goods FROM authenticated;
GRANT UPDATE (name,unit,reorder_threshold,supplier_name,supplier_contact,material_code) ON public.raw_materials TO authenticated;
GRANT UPDATE (product_name,spec_thickness,spec_width,color,warehouse_location,stage,
  customer_id,unit_price,bundle_size,customer_orderable) ON public.finished_goods TO authenticated;
CREATE OR REPLACE FUNCTION public.require_zero_initial_stock()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.current_stock<>0 THEN RAISE EXCEPTION 'Create catalog items with zero stock; use an audited stock receipt to add stock'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER trg_raw_initial_stock BEFORE INSERT ON public.raw_materials FOR EACH ROW EXECUTE FUNCTION public.require_zero_initial_stock();
CREATE TRIGGER trg_finished_initial_stock BEFORE INSERT ON public.finished_goods FOR EACH ROW EXECUTE FUNCTION public.require_zero_initial_stock();
REVOKE CREATE ON SCHEMA public FROM PUBLIC,anon,authenticated;

-- Legacy roll inventory cannot be automatically backfilled because individual
-- weights and roll numbers are unknown. Report discrepancies for physical reconciliation.
COMMENT ON VIEW public.roll_stock_discrepancies IS 'RECONCILIATION REQUIRED: do not fabricate individual roll weights for old aggregate stock.';

-- Limit company field updates; prevent reassignment of account ownership via REST.
REVOKE UPDATE ON public.customers FROM authenticated;
GRANT UPDATE (name,business_name,contact_phone,contact_email,address,credit_terms_days,approval_status)
  ON public.customers TO authenticated;
-- Notification contents cannot be overwritten by the recipient.
REVOKE UPDATE ON public.notifications FROM authenticated;
GRANT UPDATE (is_read) ON public.notifications TO authenticated;

ALTER TABLE public.employees ADD CONSTRAINT employees_profile_unique UNIQUE(profile_id);
