-- An input semi-finished physical roll may be used across multiple finished
-- products, including two outputs of the same micron, and across later runs.
-- Each output claims an explicit measured KG portion. Physical remaining kg is
-- tracked separately from the original weight, and roll-count stock is removed
-- only after the last portion has been consumed.
-- Do not edit historical migrations; 028 upgrades the new allocation pathway.

ALTER TABLE public.product_rolls
  ADD COLUMN original_weight_kg NUMERIC(8,2);
UPDATE public.product_rolls SET original_weight_kg=weight_kg;
ALTER TABLE public.product_rolls ALTER COLUMN original_weight_kg SET NOT NULL;

-- The existing weight_kg is now the live remaining weight. A spent roll may
-- weigh zero but cannot be available or reserved at zero weight.
ALTER TABLE public.product_rolls DROP CONSTRAINT IF EXISTS product_rolls_weight_kg_check;
ALTER TABLE public.product_rolls ADD CONSTRAINT product_rolls_weight_kg_check
  CHECK (weight_kg>=0 AND weight_kg<=500 AND
    (status NOT IN ('available','reserved') OR weight_kg>0));

CREATE OR REPLACE FUNCTION public.preserve_original_roll_weight()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    NEW.original_weight_kg:=NEW.weight_kg;
  ELSIF NEW.original_weight_kg IS DISTINCT FROM OLD.original_weight_kg THEN
    RAISE EXCEPTION 'Original physical roll weight cannot be changed';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER trg_preserve_original_roll_weight
  BEFORE INSERT OR UPDATE ON public.product_rolls
  FOR EACH ROW EXECUTE FUNCTION public.preserve_original_roll_weight();

ALTER TABLE public.production_runs ADD COLUMN input_accounting_mode TEXT NOT NULL DEFAULT 'standard'
  CHECK (input_accounting_mode IN ('standard','allocated_kg'));

-- One source roll can supply many outputs: primary output has NULL extra-output ID.
CREATE TABLE public.production_run_roll_allocations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  production_run_id UUID NOT NULL REFERENCES public.production_runs(id) ON DELETE RESTRICT,
  production_output_id UUID REFERENCES public.production_run_additional_outputs(id) ON DELETE RESTRICT,
  input_roll_id UUID NOT NULL REFERENCES public.product_rolls(id) ON DELETE RESTRICT,
  consumed_weight_kg NUMERIC(8,2) NOT NULL CHECK (consumed_weight_kg>0 AND consumed_weight_kg<=500),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (production_run_id,production_output_id,input_roll_id)
);
CREATE INDEX idx_run_roll_allocations_source ON public.production_run_roll_allocations(input_roll_id);
CREATE INDEX idx_run_roll_allocations_run ON public.production_run_roll_allocations(production_run_id);
ALTER TABLE public.production_run_roll_allocations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authorized production staff read allocated portions"
  ON public.production_run_roll_allocations FOR SELECT TO authenticated
  USING (public.get_user_role() IN ('admin','production_supervisor'));
REVOKE ALL ON TABLE public.production_run_roll_allocations FROM PUBLIC,anon,authenticated;
GRANT SELECT ON TABLE public.production_run_roll_allocations TO authenticated;

CREATE OR REPLACE FUNCTION public.prevent_roll_allocation_mutation()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'Physical roll consumption ledger is immutable';
END; $$;
CREATE TRIGGER trg_roll_allocations_immutable
  BEFORE UPDATE OR DELETE ON public.production_run_roll_allocations
  FOR EACH ROW EXECUTE FUNCTION public.prevent_roll_allocation_mutation();

-- Existing run posting still debits whole rolls normally. Only the new secured
-- allocation RPC explicitly sets allocated_kg and performs weight debits itself.
CREATE OR REPLACE FUNCTION public.process_production_run_inventory()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_stage public.machine_stage; v_stock NUMERIC;
BEGIN
  SELECT stage INTO v_stage FROM public.machines WHERE id=NEW.machine_id;
  IF v_stage IS NULL THEN RAISE EXCEPTION 'Machine not found'; END IF;
  IF v_stage='conversion' THEN
    IF NEW.input_product_id IS NULL OR NEW.input_quantity_consumed<=0 THEN
      RAISE EXCEPTION 'Conversion run requires a positive semi-finished input';
    END IF;
    IF NEW.input_accounting_mode='standard' THEN
      SELECT current_stock INTO v_stock FROM public.finished_goods
        WHERE id=NEW.input_product_id FOR UPDATE;
      IF v_stock IS NULL OR v_stock<NEW.input_quantity_consumed THEN
        RAISE EXCEPTION 'Insufficient semi-finished stock';
      END IF;
      UPDATE public.finished_goods SET current_stock=current_stock-NEW.input_quantity_consumed
        WHERE id=NEW.input_product_id;
      PERFORM public.record_stock_movement('finished',NEW.input_product_id,'out',
        NEW.input_quantity_consumed,'production_run',NEW.id,'Semi-finished input consumed in conversion run');
    END IF;
  ELSIF NEW.input_accounting_mode='allocated_kg' THEN
    RAISE EXCEPTION 'Weight allocation is only supported for conversion machines';
  END IF;
  IF NEW.finished_good_id IS NOT NULL AND NEW.output_quantity>0 THEN
    UPDATE public.finished_goods SET current_stock=current_stock+NEW.output_quantity
      WHERE id=NEW.finished_good_id;
    PERFORM public.record_stock_movement('finished',NEW.finished_good_id,'in',
      NEW.output_quantity,'production_run',NEW.id,'Production output');
  END IF;
  RETURN NEW;
END; $$;

-- The new RPC is for multi-output conversion runs where EVERY semi-finished
-- input is a physical roll. Other workflows keep using post_multi_production_run.
-- This is one DB transaction: any failed validation rolls back all product
-- credits, physical roll deductions, and allocation ledger entries.
CREATE OR REPLACE FUNCTION public.post_allocated_conversion_run(
  p_run JSONB, p_additional_outputs JSONB
) RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
  v_run UUID;
  v_row public.production_runs%ROWTYPE;
  v_extra_row public.production_run_additional_outputs%ROWTYPE;
  v_machine_stage public.machine_stage;
  v_output_stage public.product_stage;
  v_output_unit public.output_unit;
  v_output_micron NUMERIC;
  v_input_stage public.product_stage;
  v_input_unit public.output_unit;
  v_input_micron NUMERIC;
  v_line JSONB;
  v_allocation JSONB;
  v_parts JSONB := '[]'::jsonb;
  v_line_parts JSONB;
  v_line_sum NUMERIC;
  v_line_weight NUMERIC;
  v_amount NUMERIC;
  v_line_idx INTEGER :=0;
  v_line_count INTEGER;
  v_ids UUID[];
  v_roll RECORD;
  v_used NUMERIC;
  v_left NUMERIC;
  v_output_ids UUID[] := ARRAY[NULL::UUID];
  v_extra_id UUID;
  v_input_id UUID;
  v_finished_id UUID;
  v_thickness NUMERIC;
BEGIN
  IF auth.uid() IS NULL OR public.get_user_role() NOT IN ('admin','production_supervisor') THEN
    RAISE EXCEPTION 'Production supervisor role required' USING ERRCODE='42501';
  END IF;
  IF jsonb_typeof(p_run) IS DISTINCT FROM 'object' OR
     jsonb_typeof(p_additional_outputs) IS DISTINCT FROM 'array' OR
     jsonb_array_length(p_additional_outputs) NOT BETWEEN 1 AND 19 THEN
    RAISE EXCEPTION 'Provide a primary product and 1-19 additional products';
  END IF;
  SELECT stage INTO v_machine_stage FROM public.machines
    WHERE id=(p_run->>'machine_id')::uuid AND is_active;
  IF v_machine_stage IS DISTINCT FROM 'conversion'::public.machine_stage THEN
    RAISE EXCEPTION 'Shared physical roll allocations require an active conversion machine';
  END IF;

  -- Use the same validation for the primary and each extra line. JSON order
  -- determines the stable output reference within this transaction only.
  FOR v_line IN
    SELECT line FROM (
      SELECT 0 AS idx, p_run || jsonb_build_object('_line_index',0) AS line
      UNION ALL
      SELECT x.ordinality::integer AS idx,
        x.value || jsonb_build_object('_line_index',x.ordinality) AS line
      FROM jsonb_array_elements(p_additional_outputs) WITH ORDINALITY AS x(value,ordinality)
    ) indexed_lines ORDER BY idx
  LOOP
    v_line_idx:=(v_line->>'_line_index')::integer;
    v_input_id:=(v_line->>'input_product_id')::uuid;
    v_finished_id:=(v_line->>'finished_good_id')::uuid;
    v_thickness:=NULLIF(v_line->>'film_thickness','')::numeric;
    SELECT stage,unit,spec_thickness INTO v_input_stage,v_input_unit,v_input_micron
      FROM public.finished_goods WHERE id=v_input_id;
    SELECT stage,unit,spec_thickness INTO v_output_stage,v_output_unit,v_output_micron
      FROM public.finished_goods WHERE id=v_finished_id;
    IF v_input_stage IS DISTINCT FROM 'semi_finished'::public.product_stage OR
       v_input_unit IS DISTINCT FROM 'rolls'::public.output_unit OR
       v_output_stage IS DISTINCT FROM 'finished'::public.product_stage OR
       v_output_unit IS DISTINCT FROM (v_line->>'output_unit')::public.output_unit THEN
      RAISE EXCEPTION 'Each finished output must select a roll-counted semi-finished input';
    END IF;
    IF (v_input_micron IS NOT NULL AND v_output_micron IS NOT NULL AND
        ABS(v_input_micron-v_output_micron)>0.1) OR
       (v_input_micron IS NOT NULL AND v_thickness IS NOT NULL AND
        ABS(v_input_micron-v_thickness)>0.1) OR
       (v_output_micron IS NOT NULL AND v_thickness IS NOT NULL AND
        ABS(v_output_micron-v_thickness)>0.1) THEN
      RAISE EXCEPTION 'Input and finished output micron specifications do not match';
    END IF;
    v_line_parts:=v_line->'input_roll_allocations';
    IF jsonb_typeof(v_line_parts) IS DISTINCT FROM 'array' OR
       jsonb_array_length(v_line_parts) NOT BETWEEN 1 AND 1000 THEN
      RAISE EXCEPTION 'Each output must specify one or more weighted physical roll portions';
    END IF;
    SELECT COUNT(DISTINCT (a->>'roll_id')::uuid) INTO v_line_count
      FROM jsonb_array_elements(v_line_parts) a;
    IF v_line_count<>jsonb_array_length(v_line_parts) THEN
      RAISE EXCEPTION 'Do not repeat a physical input roll within the same output line';
    END IF;
    v_line_sum:=0;
    FOR v_allocation IN SELECT value FROM jsonb_array_elements(v_line_parts) LOOP
      IF jsonb_typeof(v_allocation) IS DISTINCT FROM 'object' OR
         NULLIF(v_allocation->>'roll_id','') IS NULL OR
         NULLIF(v_allocation->>'weight_kg','') IS NULL THEN
        RAISE EXCEPTION 'Input roll allocation needs roll ID and kilograms';
      END IF;
      v_amount:=(v_allocation->>'weight_kg')::numeric;
      IF v_amount IS NULL OR v_amount<=0 OR v_amount>500 OR v_amount<>ROUND(v_amount,2) THEN
        RAISE EXCEPTION 'Allocated kilograms must be 0.01-500.00 with at most 2 decimal places';
      END IF;
      v_line_sum:=v_line_sum+v_amount;
      v_parts:=v_parts || jsonb_build_array(jsonb_build_object(
        'line',v_line_idx,'roll_id',v_allocation->>'roll_id','weight_kg',v_amount,
        'input_product_id',v_input_id,'output_product_id',v_finished_id,
        'input_micron',v_input_micron,'output_micron',v_output_micron,'thickness',v_thickness));
    END LOOP;
    IF v_line_sum<=0 THEN RAISE EXCEPTION 'An input weight is required'; END IF;
    IF v_output_unit='rolls' THEN
      IF jsonb_typeof(v_line->'roll_weights') IS DISTINCT FROM 'array' OR
         jsonb_array_length(v_line->'roll_weights') NOT BETWEEN 1 AND 1000 THEN
        RAISE EXCEPTION 'Finished roll output must include individual measured weights';
      END IF;
      SELECT SUM(w::numeric) INTO v_line_weight
        FROM jsonb_array_elements_text(v_line->'roll_weights') w;
    ELSE
      v_line_weight:=(v_line->>'output_quantity')::numeric;
    END IF;
    IF v_line_weight IS NULL OR v_line_weight<=0 OR
       (v_output_unit IN ('kg','rolls') AND v_line_weight>v_line_sum+0.01) THEN
      RAISE EXCEPTION 'Finished output is invalid or its kilograms exceed the allocated input';
    END IF;
    IF v_line_idx=0 THEN
      v_row:=jsonb_populate_record(NULL::public.production_runs,p_run);
      v_row.input_quantity_consumed:=v_line_sum;
    END IF;
  END LOOP;

  SELECT ARRAY_AGG(DISTINCT (x->>'roll_id')::uuid) INTO v_ids
    FROM jsonb_array_elements(v_parts) x;
  -- Lock in a stable order to prevent two operators using the same remainder.
  PERFORM id FROM public.product_rolls WHERE id=ANY(v_ids) ORDER BY id FOR UPDATE;
  FOR v_roll IN SELECT r.id,r.finished_good_id,r.weight_kg,r.micron,r.status
    FROM public.product_rolls r WHERE r.id=ANY(v_ids) ORDER BY r.id LOOP
    IF v_roll.status IS DISTINCT FROM 'available'::public.roll_status THEN
      RAISE EXCEPTION 'An input roll has been reserved or consumed; refresh available rolls';
    END IF;
    IF EXISTS(SELECT 1 FROM jsonb_array_elements(v_parts) x
      WHERE (x->>'roll_id')::uuid=v_roll.id AND (
        (x->>'input_product_id')::uuid<>v_roll.finished_good_id OR
        (v_roll.micron IS NOT NULL AND ( 
          (x->>'input_micron') IS NOT NULL AND ABS(v_roll.micron-(x->>'input_micron')::numeric)>0.1 OR
          (x->>'output_micron') IS NOT NULL AND ABS(v_roll.micron-(x->>'output_micron')::numeric)>0.1 OR
          (x->>'thickness') IS NOT NULL AND ABS(v_roll.micron-(x->>'thickness')::numeric)>0.1
        ))
      )) THEN RAISE EXCEPTION 'Selected source roll does not match the finished output micron or input product'; END IF;
    SELECT SUM((x->>'weight_kg')::numeric) INTO v_used FROM jsonb_array_elements(v_parts) x
      WHERE (x->>'roll_id')::uuid=v_roll.id;
    IF v_used>v_roll.weight_kg THEN
      RAISE EXCEPTION 'Input roll has only % kg remaining, but % kg was allocated',v_roll.weight_kg,v_used;
    END IF;
  END LOOP;
  IF COALESCE(cardinality(v_ids),0)<>(SELECT COUNT(*) FROM public.product_rolls WHERE id=ANY(v_ids)) THEN
    RAISE EXCEPTION 'One or more selected source rolls no longer exist';
  END IF;

  -- Explicit columns preserve audit fields and table defaults. Allocated_kg
  -- bypasses the legacy whole-roll debit in the production-run trigger.
  INSERT INTO public.production_runs (
    run_date,shift,machine_id,operator_name,finished_good_id,film_thickness,
    film_width,film_color,output_quantity,output_unit,input_product_id,
    input_quantity_consumed,supervisor_name,process_type,formula_code,roll_count,
    roll_length,avg_weight_per_roll,start_time,end_time,total_runtime_hours,
    downtime_hours,temp_z1,temp_z2,temp_z3,temp_z4,temp_z5,temp_z6,
    screw_speed_rpm,line_speed_mpm,cut_length_mm,bottom_seal_offset_mm,
    cutting_speed_cpm,print_colours_count,print_speed,print_tension,
    cleaned_rollers,roll_edges_ok,neatness_rating,samples_tested,samples_passed,
    samples_failed,qc_issues,qc_issue_other,batch_id,quality_grade,
    waste_quantity,notes,roll_weights,created_by,input_accounting_mode
  ) VALUES (
    COALESCE(v_row.run_date,CURRENT_DATE),v_row.shift,v_row.machine_id,v_row.operator_name,
    v_row.finished_good_id,v_row.film_thickness,v_row.film_width,v_row.film_color,
    v_row.output_quantity,v_row.output_unit,v_row.input_product_id,
    v_row.input_quantity_consumed,v_row.supervisor_name,v_row.process_type,
    v_row.formula_code,v_row.roll_count,v_row.roll_length,v_row.avg_weight_per_roll,
    v_row.start_time,v_row.end_time,v_row.total_runtime_hours,
    COALESCE(v_row.downtime_hours,0),v_row.temp_z1,v_row.temp_z2,v_row.temp_z3,
    v_row.temp_z4,v_row.temp_z5,v_row.temp_z6,v_row.screw_speed_rpm,
    v_row.line_speed_mpm,v_row.cut_length_mm,v_row.bottom_seal_offset_mm,
    v_row.cutting_speed_cpm,v_row.print_colours_count,v_row.print_speed,
    v_row.print_tension,v_row.cleaned_rollers,v_row.roll_edges_ok,
    v_row.neatness_rating,v_row.samples_tested,v_row.samples_passed,
    v_row.samples_failed,v_row.qc_issues,v_row.qc_issue_other,v_row.batch_id,
    v_row.quality_grade,COALESCE(v_row.waste_quantity,0),v_row.notes,
    v_row.roll_weights,auth.uid(),'allocated_kg'
  ) RETURNING id INTO v_run;

  FOR v_line IN SELECT value FROM jsonb_array_elements(p_additional_outputs) LOOP
    v_extra_row:=jsonb_populate_record(NULL::public.production_run_additional_outputs,v_line);
    SELECT SUM((a->>'weight_kg')::numeric) INTO v_line_sum
      FROM jsonb_array_elements(v_line->'input_roll_allocations') a;
    INSERT INTO public.production_run_additional_outputs (
      production_run_id,finished_good_id,output_quantity,output_unit,roll_weights,
      film_thickness,film_width,film_color,batch_id,quality_grade,
      input_product_id,input_quantity_consumed
    ) VALUES (
      v_run,v_extra_row.finished_good_id,v_extra_row.output_quantity,v_extra_row.output_unit,
      v_extra_row.roll_weights,v_extra_row.film_thickness,v_extra_row.film_width,
      v_extra_row.film_color,v_extra_row.batch_id,v_extra_row.quality_grade,
      v_extra_row.input_product_id,v_line_sum
    ) RETURNING id INTO v_extra_id;
    v_output_ids:=array_append(v_output_ids,v_extra_id);
  END LOOP;

  FOR v_allocation IN SELECT value FROM jsonb_array_elements(v_parts) LOOP
    INSERT INTO public.production_run_roll_allocations (
      production_run_id,production_output_id,input_roll_id,consumed_weight_kg
    ) VALUES (
      v_run,v_output_ids[(v_allocation->>'line')::integer+1],
      (v_allocation->>'roll_id')::uuid,(v_allocation->>'weight_kg')::numeric
    );
  END LOOP;

  -- Decrease weight once per unique physical source roll, not once per output.
  -- Fully consumed rolls reduce roll-counted stock; partially used rolls
  -- stay available with their measured remaining kg for subsequent runs.
  FOR v_roll IN SELECT id,finished_good_id,weight_kg FROM public.product_rolls
    WHERE id=ANY(v_ids) ORDER BY id LOOP
    SELECT SUM(a.consumed_weight_kg) INTO v_used
      FROM public.production_run_roll_allocations a
      WHERE a.production_run_id=v_run AND a.input_roll_id=v_roll.id;
    v_left:=v_roll.weight_kg-v_used;
    UPDATE public.product_rolls SET weight_kg=v_left,
      status=CASE WHEN v_left=0 THEN 'consumed'::public.roll_status ELSE 'available'::public.roll_status END,
      consumed_in_run_id=CASE WHEN v_left=0 THEN v_run ELSE consumed_in_run_id END,
      consumed_in_output_id=NULL
    WHERE id=v_roll.id;
    IF v_left=0 THEN
      UPDATE public.finished_goods SET current_stock=current_stock-1
        WHERE id=v_roll.finished_good_id AND current_stock>=1;
      IF NOT FOUND THEN RAISE EXCEPTION 'Physical roll stock is inconsistent; reconcile inventory'; END IF;
      PERFORM public.record_stock_movement('finished',v_roll.finished_good_id,'out',1,
        'production_run',v_run,'Semi-finished roll depleted across production outputs');
    END IF;
  END LOOP;
  RETURN v_run;
END; $$;
REVOKE ALL ON FUNCTION public.post_allocated_conversion_run(JSONB,JSONB) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.post_allocated_conversion_run(JSONB,JSONB) TO authenticated;

COMMENT ON COLUMN public.product_rolls.weight_kg IS 'Remaining measurable weight (kg) of this physical roll; zero only when consumed.';
COMMENT ON COLUMN public.product_rolls.original_weight_kg IS 'Original physical roll weight at creation, preserved when allocating partial quantities.';
COMMENT ON TABLE public.production_run_roll_allocations IS 'Immutable kg allocation of one physical semi-finished roll across one or more finished outputs (including outputs in subsequent runs).';
-- Search results now include original and remaining weight for partially used rolls.
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
      r.weight_kg, r.original_weight_kg, r.micron, r.status::text AS status,
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



NOTIFY pgrst, 'reload schema';
