-- One production report may yield multiple semi-finished OR multiple finished products.
-- Preserve the original primary output on production_runs for historical compatibility.
-- Additional outputs share that report's machine, shift, inputs, operator and date.
-- All postings are atomic via post_multi_production_run. Do not edit old migrations.

CREATE TABLE public.production_run_additional_outputs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  production_run_id UUID NOT NULL REFERENCES public.production_runs(id) ON DELETE RESTRICT,
  finished_good_id UUID NOT NULL REFERENCES public.finished_goods(id),
  output_quantity NUMERIC(12,2) NOT NULL CHECK (output_quantity > 0),
  output_unit public.output_unit NOT NULL,
  roll_weights NUMERIC(8,2)[],
  film_thickness NUMERIC(6,2),
  film_width NUMERIC(8,2),
  film_color TEXT,
  batch_id TEXT,
  quality_grade SMALLINT CHECK (quality_grade BETWEEN 1 AND 3),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_production_additional_run ON public.production_run_additional_outputs(production_run_id);
CREATE INDEX idx_production_additional_product ON public.production_run_additional_outputs(finished_good_id);

ALTER TABLE public.product_rolls
  ADD COLUMN production_output_id UUID REFERENCES public.production_run_additional_outputs(id) ON DELETE RESTRICT;
CREATE INDEX idx_product_rolls_output ON public.product_rolls(production_output_id);

ALTER TABLE public.production_run_additional_outputs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Production staff read additional outputs" ON public.production_run_additional_outputs
  FOR SELECT TO authenticated
  USING (public.get_user_role() IN ('admin','production_supervisor'));
REVOKE ALL ON TABLE public.production_run_additional_outputs FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.production_run_additional_outputs TO authenticated;

CREATE OR REPLACE FUNCTION public.validate_production_additional_output()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_stage public.machine_stage; v_expected public.product_stage;
        v_actual public.product_stage; v_unit public.output_unit;
BEGIN
  SELECT m.stage INTO v_stage FROM public.production_runs pr
    JOIN public.machines m ON m.id=pr.machine_id WHERE pr.id=NEW.production_run_id;
  IF v_stage IS NULL THEN RAISE EXCEPTION 'Production run not found'; END IF;
  v_expected:=CASE WHEN v_stage='conversion' THEN 'finished'::public.product_stage
                   ELSE 'semi_finished'::public.product_stage END;
  SELECT stage,unit INTO v_actual,v_unit FROM public.finished_goods WHERE id=NEW.finished_good_id;
  IF v_actual IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION 'Output product must belong to % stage',v_expected;
  END IF;
  IF v_unit IS DISTINCT FROM NEW.output_unit THEN
    RAISE EXCEPTION 'Output unit must match the product stock unit';
  END IF;
  IF v_unit='rolls' THEN
    IF COALESCE(cardinality(NEW.roll_weights),0) NOT BETWEEN 1 AND 1000 OR
       EXISTS (SELECT 1 FROM unnest(NEW.roll_weights) w WHERE w IS NULL OR w<=0 OR w>500) THEN
      RAISE EXCEPTION 'Enter 1-1000 measured roll weights (0-500 kg per roll)';
    END IF;
    NEW.output_quantity:=cardinality(NEW.roll_weights);
  ELSIF COALESCE(cardinality(NEW.roll_weights),0)<>0 THEN
    RAISE EXCEPTION 'Roll weights are only supported for roll-counted products';
  END IF;
  IF NEW.output_quantity IS NULL OR NEW.output_quantity<=0 THEN
    RAISE EXCEPTION 'Output quantity must be greater than zero';
  END IF;
  RETURN NEW;
END; $$;

CREATE TRIGGER trg_validate_production_additional_output
BEFORE INSERT ON public.production_run_additional_outputs FOR EACH ROW
EXECUTE FUNCTION public.validate_production_additional_output();

CREATE OR REPLACE FUNCTION public.post_production_additional_output_stock()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_micron NUMERIC;
BEGIN
  UPDATE public.finished_goods SET current_stock=current_stock+NEW.output_quantity
    WHERE id=NEW.finished_good_id;
  PERFORM public.record_stock_movement('finished',NEW.finished_good_id,'in',NEW.output_quantity,
    'production_run',NEW.production_run_id, 'Additional product output: '||NEW.id::text);
  IF NEW.output_unit='rolls' THEN
    SELECT COALESCE(NEW.film_thickness,pr.film_thickness) INTO v_micron
      FROM public.production_runs pr WHERE pr.id=NEW.production_run_id;
    INSERT INTO public.product_rolls(finished_good_id,production_run_id,production_output_id,weight_kg,micron)
      SELECT NEW.finished_good_id,NEW.production_run_id,NEW.id,w,v_micron
      FROM unnest(NEW.roll_weights) WITH ORDINALITY AS t(w,ord) ORDER BY ord;
  END IF;
  RETURN NEW;
END; $$;

CREATE TRIGGER trg_post_production_additional_output_stock
AFTER INSERT ON public.production_run_additional_outputs FOR EACH ROW
EXECUTE FUNCTION public.post_production_additional_output_stock();

CREATE OR REPLACE FUNCTION public.prevent_production_additional_output_mutation()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'Production output ledger is immutable; post a corrective stock adjustment';
END; $$;
CREATE TRIGGER trg_production_additional_immutable
BEFORE UPDATE OR DELETE ON public.production_run_additional_outputs FOR EACH ROW
EXECUTE FUNCTION public.prevent_production_additional_output_mutation();

-- Re-use the hardened primary-run RPC; it deducts materials or physical input rolls
-- exactly ONCE, then this function creates the remaining output lines in the same txn.
CREATE OR REPLACE FUNCTION public.post_multi_production_run(
  p_run JSONB, p_materials JSONB, p_additional_outputs JSONB
) RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_run UUID; v_stage public.machine_stage; v_expected public.product_stage;
        v_actual public.product_stage; v_unit public.output_unit;
        v_extra JSONB; v_row public.production_run_additional_outputs%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR public.get_user_role() NOT IN ('admin','production_supervisor') THEN
    RAISE EXCEPTION 'Production supervisor role required' USING ERRCODE='42501';
  END IF;
  IF jsonb_typeof(p_run) IS DISTINCT FROM 'object' OR
     jsonb_typeof(p_materials) IS DISTINCT FROM 'array' OR
     jsonb_typeof(p_additional_outputs) IS DISTINCT FROM 'array' OR
     jsonb_array_length(p_additional_outputs) NOT BETWEEN 1 AND 19 THEN
    RAISE EXCEPTION 'Provide one main output and 1-19 additional product outputs';
  END IF;
  SELECT stage INTO v_stage FROM public.machines
    WHERE id=(p_run->>'machine_id')::uuid AND is_active;
  IF v_stage IS NULL THEN RAISE EXCEPTION 'Select an active machine'; END IF;
  v_expected:=CASE WHEN v_stage='conversion' THEN 'finished'::public.product_stage
                   ELSE 'semi_finished'::public.product_stage END;
  SELECT stage,unit INTO v_actual,v_unit FROM public.finished_goods
    WHERE id=(p_run->>'finished_good_id')::uuid;
  IF v_actual IS DISTINCT FROM v_expected OR (p_run->>'output_unit')::public.output_unit IS DISTINCT FROM v_unit THEN
    RAISE EXCEPTION 'Main output must be a % product with matching stock unit',v_expected;
  END IF;

  -- Before writing anything, verify that every extra product belongs to this stage.
  FOR v_extra IN SELECT value FROM jsonb_array_elements(p_additional_outputs) LOOP
    IF jsonb_typeof(v_extra) IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'Invalid output line'; END IF;
    v_row:=jsonb_populate_record(NULL::public.production_run_additional_outputs,v_extra);
    IF v_row.finished_good_id IS NULL THEN RAISE EXCEPTION 'Select an output product'; END IF;
    SELECT stage,unit INTO v_actual,v_unit FROM public.finished_goods WHERE id=v_row.finished_good_id;
    IF v_actual IS DISTINCT FROM v_expected OR v_unit IS DISTINCT FROM v_row.output_unit THEN
      RAISE EXCEPTION 'Every output must be a % product with matching stock unit',v_expected;
    END IF;
    IF v_row.output_quantity IS NULL OR v_row.output_quantity<=0 THEN
      RAISE EXCEPTION 'Output quantity must be positive';
    END IF;
  END LOOP;

  v_run:=public.post_production_run(p_run,p_materials);
  FOR v_extra IN SELECT value FROM jsonb_array_elements(p_additional_outputs) LOOP
    v_row:=jsonb_populate_record(NULL::public.production_run_additional_outputs,v_extra);
    INSERT INTO public.production_run_additional_outputs(
      production_run_id,finished_good_id,output_quantity,output_unit,roll_weights,
      film_thickness,film_width,film_color,batch_id,quality_grade)
    VALUES(v_run,v_row.finished_good_id,v_row.output_quantity,v_row.output_unit,v_row.roll_weights,
      v_row.film_thickness,v_row.film_width,v_row.film_color,v_row.batch_id,v_row.quality_grade);
  END LOOP;
  RETURN v_run;
END; $$;
REVOKE ALL ON FUNCTION public.post_multi_production_run(JSONB,JSONB,JSONB) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.post_multi_production_run(JSONB,JSONB,JSONB) TO authenticated;

-- Update administrator roll lookup to use the batch/quality of each additional
-- output, while retaining production-run date, shift, machine and operator.
CREATE OR REPLACE FUNCTION public.search_inventory_rolls(
  p_search TEXT DEFAULT '',
  p_status TEXT DEFAULT NULL,
  p_limit INTEGER DEFAULT 50,
  p_offset INTEGER DEFAULT 0
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_query TEXT := BTRIM(COALESCE(p_search, ''));
  v_status TEXT := NULLIF(BTRIM(COALESCE(p_status, '')), '');
  v_limit INTEGER := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 100);
  v_offset INTEGER := GREATEST(COALESCE(p_offset, 0), 0);
  v_result JSONB;
BEGIN
  -- SECURITY INVOKER preserves RLS on all four joined source tables.
  IF auth.uid() IS NULL OR public.get_user_role() IS DISTINCT FROM 'admin'::public.user_role THEN
    RAISE EXCEPTION 'Administrator access required' USING ERRCODE = '42501';
  END IF;
  IF v_status IS NOT NULL AND v_status NOT IN ('available', 'reserved', 'sold', 'consumed') THEN
    RAISE EXCEPTION 'Invalid roll status';
  END IF;
  IF LENGTH(v_query) > 120 THEN
    RAISE EXCEPTION 'Search must be 120 characters or fewer';
  END IF;

  WITH matched AS MATERIALIZED (
    SELECT
      r.id, r.roll_no, r.finished_good_id, r.production_run_id,
      r.weight_kg, r.micron, r.status::text AS status,
      r.order_item_id, r.created_at,
      fg.product_name, fg.stage::text AS product_stage,
      fg.spec_thickness AS product_spec_thickness,
      fg.spec_width AS product_spec_width,
      fg.color AS product_color, fg.warehouse_location,
      fg.customer_id,
      COALESCE(NULLIF(c.business_name, ''), c.name) AS brand_name,
      CASE WHEN extra.id IS NOT NULL THEN extra.batch_id ELSE pr.batch_id END AS batch_id, pr.run_date AS production_date,
      pr.shift::text AS production_shift,
      pr.operator_name, pr.supervisor_name,
      CASE WHEN extra.id IS NOT NULL THEN extra.quality_grade ELSE pr.quality_grade END AS quality_grade, pr.notes AS production_notes,
      pr.process_type::text AS process_type,
      pr.created_at AS run_logged_at,
      m.name AS machine_name, m.machine_code
    FROM public.product_rolls r
    JOIN public.finished_goods fg ON fg.id = r.finished_good_id
    LEFT JOIN public.customers c ON c.id = fg.customer_id
    LEFT JOIN public.production_runs pr ON pr.id = r.production_run_id
    LEFT JOIN public.production_run_additional_outputs extra ON extra.id = r.production_output_id
    LEFT JOIN public.machines m ON m.id = pr.machine_id
    WHERE (v_status IS NULL OR r.status::text = v_status)
      AND (
        v_query = ''
        OR r.roll_no::text ILIKE '%' || v_query || '%'
        OR fg.product_name ILIKE '%' || v_query || '%'
        OR COALESCE(c.business_name, '') ILIKE '%' || v_query || '%'
        OR COALESCE(c.name, '') ILIKE '%' || v_query || '%'
        OR COALESCE(CASE WHEN extra.id IS NOT NULL THEN extra.batch_id ELSE pr.batch_id END, '') ILIKE '%' || v_query || '%'
        OR pr.run_date::text ILIKE '%' || v_query || '%'
        OR pr.id::text ILIKE '%' || v_query || '%'
        OR r.id::text ILIKE '%' || v_query || '%'
      )
  ),
  total AS (SELECT COUNT(*) AS count FROM matched),
  paged AS (
    SELECT * FROM matched ORDER BY roll_no DESC LIMIT v_limit OFFSET v_offset
  ),
  results AS (
    SELECT COALESCE(jsonb_agg(to_jsonb(paged) ORDER BY roll_no DESC), '[]'::jsonb) AS rows
    FROM paged
  )
  SELECT jsonb_build_object('total', total.count, 'rows', results.rows)
    INTO v_result
  FROM total CROSS JOIN results;

  RETURN v_result;
END;
$$;


COMMENT ON FUNCTION public.post_multi_production_run(JSONB,JSONB,JSONB) IS
'Atomic multi-product run: primary output posts inputs once; additional lines post distinct stock and physical roll ledgers.';

-- Ensure the admin dashboard includes every output line without counting the
-- material input or waste more than once. Prior months use the same units.
CREATE OR REPLACE FUNCTION public.dashboard_metrics(p_month DATE DEFAULT CURRENT_DATE)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_from DATE:=date_trunc('month',p_month)::date; v_until DATE:=(date_trunc('month',p_month)+INTERVAL '1 month')::date;
  v_out JSONB:='{}'::jsonb; v_material NUMERIC; v_output NUMERIC; v_waste NUMERIC;
BEGIN
  IF auth.uid() IS NULL OR get_user_role() IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF get_user_role() IN ('admin','production_supervisor') THEN
    SELECT COALESCE(SUM(
      (CASE WHEN pr.output_unit='kg' THEN pr.output_quantity
        ELSE (SELECT COALESCE(SUM(w),0) FROM unnest(pr.roll_weights) w) END)
      + COALESCE((SELECT SUM(CASE WHEN extra.output_unit='kg' THEN extra.output_quantity
        ELSE (SELECT COALESCE(SUM(w),0) FROM unnest(extra.roll_weights) w) END)
        FROM production_run_additional_outputs extra WHERE extra.production_run_id=pr.id),0)
    ),0),
      COALESCE(SUM(pr.waste_quantity),0) INTO v_output,v_waste
    FROM production_runs pr JOIN machines m ON m.id=pr.machine_id
    WHERE m.stage='extrusion' AND pr.run_date>=v_from AND pr.run_date<v_until;
    SELECT COALESCE(SUM(prm.quantity_kg),0) INTO v_material
    FROM production_run_materials prm JOIN production_runs pr ON pr.id=prm.production_run_id
    JOIN machines m ON m.id=pr.machine_id
    WHERE m.stage='extrusion' AND pr.run_date>=v_from AND pr.run_date<v_until;
    v_out:=v_out||jsonb_build_object('output_kg',v_output,
      'roll_count',(
        (SELECT COALESCE(SUM(output_quantity),0) FROM production_runs WHERE run_date>=v_from AND run_date<v_until AND output_unit='rolls')
        + (SELECT COALESCE(SUM(extra.output_quantity),0) FROM production_run_additional_outputs extra
           JOIN production_runs pr ON pr.id=extra.production_run_id
           WHERE pr.run_date>=v_from AND pr.run_date<v_until AND extra.output_unit='rolls')
      ),
      'input_kg',v_material,'yield_percent',CASE WHEN v_material>0 THEN ROUND(v_output*100/v_material,1) ELSE 0 END,
      'waste_percent',CASE WHEN v_material>0 THEN ROUND(v_waste*100/v_material,1) ELSE 0 END,
      'downtime_hours',(SELECT COALESCE(SUM(duration_minutes),0)/60 FROM machine_downtime WHERE start_time>=v_from::timestamptz AND start_time<v_until::timestamptz));
  END IF;
  IF get_user_role() IN ('admin','sales_staff') THEN
    v_out:=v_out||jsonb_build_object('monthly_receipts',
      (SELECT COALESCE(SUM(amount),0) FROM payments WHERE created_at>=v_from::timestamptz AND created_at<v_until::timestamptz)
      -(SELECT COALESCE(SUM(r.amount),0) FROM payment_refunds r WHERE r.created_at>=v_from::timestamptz AND r.created_at<v_until::timestamptz),
      'outstanding',(SELECT COALESCE(SUM(balance_due),0) FROM orders WHERE status NOT IN ('cancelled','pending')));
  END IF;
  IF get_user_role() IN ('admin','production_supervisor','sales_staff') THEN
    v_out:=v_out||jsonb_build_object('low_stock_count',
      (SELECT COUNT(*) FROM raw_materials WHERE reorder_threshold>0 AND current_stock<=reorder_threshold));
  END IF;
  IF get_user_role() IN ('admin','hr_officer') THEN
    v_out:=v_out||jsonb_build_object('active_employees',(SELECT COUNT(*) FROM employees WHERE is_active),
      'today_attendance',(SELECT COUNT(*) FROM attendance WHERE attendance_date=(now() AT TIME ZONE 'Africa/Accra')::date));
  END IF;
  RETURN v_out;
END; $$;
REVOKE ALL ON FUNCTION public.dashboard_metrics(DATE) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.dashboard_metrics(DATE) TO authenticated;


CREATE OR REPLACE FUNCTION public.dashboard_trends()
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_json JSONB := '{}'::jsonb;
BEGIN
  IF auth.uid() IS NULL OR get_user_role() IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF get_user_role() IN ('admin','production_supervisor') THEN
    v_json:=v_json||jsonb_build_object('production_by_day', (
      SELECT COALESCE(jsonb_agg(row_to_json(t) ORDER BY t.date),'[]'::jsonb) FROM (
        SELECT pr.run_date::text date,
          SUM(
            (CASE WHEN pr.output_unit='kg' THEN pr.output_quantity
              ELSE (SELECT COALESCE(SUM(w),0) FROM unnest(pr.roll_weights) w) END)
            + COALESCE((SELECT SUM(CASE WHEN extra.output_unit='kg' THEN extra.output_quantity
                ELSE (SELECT COALESCE(SUM(w),0) FROM unnest(extra.roll_weights) w) END)
              FROM production_run_additional_outputs extra WHERE extra.production_run_id=pr.id),0)
          ) output
        FROM production_runs pr JOIN machines m ON m.id=pr.machine_id
        WHERE m.stage='extrusion' AND pr.run_date>=CURRENT_DATE-INTERVAL '14 days'
        GROUP BY pr.run_date ORDER BY pr.run_date) t));
  END IF;
  IF get_user_role() IN ('admin','sales_staff') THEN
    v_json:=v_json||jsonb_build_object('revenue_by_month',(
      SELECT COALESCE(jsonb_agg(row_to_json(t) ORDER BY t.month),'[]'::jsonb) FROM (
        SELECT month,SUM(net_amount) revenue FROM (
          SELECT TO_CHAR(created_at AT TIME ZONE 'Africa/Accra','YYYY-MM') AS month,
                 amount AS net_amount
          FROM payments WHERE created_at>=date_trunc('month',now())-INTERVAL '5 months'
          UNION ALL
          SELECT TO_CHAR(created_at AT TIME ZONE 'Africa/Accra','YYYY-MM'),-amount
          FROM payment_refunds WHERE created_at>=date_trunc('month',now())-INTERVAL '5 months'
        ) receipts GROUP BY month ORDER BY month) t));
  END IF;
  IF get_user_role() IN ('admin','production_supervisor','sales_staff') THEN
    v_json:=v_json||jsonb_build_object('low_stock_items',(
      SELECT COALESCE(jsonb_agg(jsonb_build_object('name',name,'stock',current_stock,'threshold',reorder_threshold)),'[]'::jsonb)
      FROM raw_materials WHERE reorder_threshold>0 AND current_stock<=reorder_threshold));
  END IF;
  RETURN v_json;
END; $$;
REVOKE ALL ON FUNCTION public.dashboard_trends() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.dashboard_trends() TO authenticated;
