-- Shared semi-finished input groups: one measured material consumption total
-- linked to several distinct finished outputs. No fabricated per-output inputs.
-- Requires migrations 025, 027 and 028. Does not rewrite historical postings.
ALTER TABLE public.production_runs DROP CONSTRAINT IF EXISTS production_runs_input_accounting_mode_check;
ALTER TABLE public.production_runs ADD CONSTRAINT production_runs_input_accounting_mode_check
  CHECK (input_accounting_mode IN ('standard','allocated_kg','shared_groups'));

CREATE TABLE public.production_run_input_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  production_run_id uuid NOT NULL REFERENCES public.production_runs(id) ON DELETE RESTRICT,
  input_product_id uuid NOT NULL REFERENCES public.finished_goods(id),
  consumed_weight_kg numeric(12,2) NOT NULL CHECK(consumed_weight_kg > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX production_input_groups_run_idx ON public.production_run_input_groups(production_run_id);
CREATE TABLE public.production_run_input_group_outputs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id uuid NOT NULL REFERENCES public.production_run_input_groups(id) ON DELETE RESTRICT,
  production_run_id uuid NOT NULL REFERENCES public.production_runs(id) ON DELETE RESTRICT,
  -- NULL designates primary output on production_runs
  production_output_id uuid REFERENCES public.production_run_additional_outputs(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (production_run_id,production_output_id)
);
CREATE TABLE public.production_run_input_group_rolls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id uuid NOT NULL REFERENCES public.production_run_input_groups(id) ON DELETE RESTRICT,
  input_roll_id uuid NOT NULL REFERENCES public.product_rolls(id) ON DELETE RESTRICT,
  consumed_weight_kg numeric(8,2) NOT NULL CHECK(consumed_weight_kg > 0 AND consumed_weight_kg <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(group_id,input_roll_id)
);
CREATE INDEX production_input_group_rolls_roll_idx ON public.production_run_input_group_rolls(input_roll_id);

DO $$ DECLARE name text; BEGIN
  FOREACH name IN ARRAY ARRAY['production_run_input_groups','production_run_input_group_outputs','production_run_input_group_rolls'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',name);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC,anon,authenticated',name);
    EXECUTE format('GRANT SELECT ON TABLE public.%I TO authenticated',name);
    EXECUTE format('CREATE POLICY "Production staff view shared inputs" ON public.%I FOR SELECT TO authenticated USING (public.get_user_role() IN (''admin'',''production_supervisor''))',name);
    EXECUTE format('CREATE TRIGGER shared_input_immutable BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.prevent_roll_allocation_mutation()',name);
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.post_shared_conversion_run(
  p_run jsonb, p_additional_outputs jsonb, p_input_groups jsonb
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
  v_run uuid;
  v_row public.production_runs%ROWTYPE;
  v_extra_row public.production_run_additional_outputs%ROWTYPE;
  v_machine_stage public.machine_stage;
  v_input_id uuid;
  v_product_id uuid;
  v_input_micron numeric;
  v_output_micron numeric;
  v_output_stage public.product_stage;
  v_input_stage public.product_stage;
  v_input_unit public.output_unit;
  v_output_unit public.output_unit;
  v_out jsonb;
  v_group jsonb;
  v_part jsonb;
  v_index integer;
  v_i integer;
  v_total numeric;
  v_output_weight numeric;
  v_group_output_weight numeric;
  v_roll_total numeric;
  v_roll record;
  v_group_id uuid;
  v_extra_ids uuid[] := ARRAY[]::uuid[];
  v_output_ids uuid[];
  v_roll_ids uuid[];
  v_roll_id uuid;
  v_primary_group jsonb;
  v_primary_input uuid;
  v_primary_consumed numeric;
  v_output_micron_actual numeric;
  v_input_product_micron numeric;
  v_roll_used numeric;
  v_left numeric;
  v_all_rolls jsonb := '[]'::jsonb;
  v_group_members jsonb := '[]'::jsonb;
  v_input_count integer;
  v_line_count integer;
BEGIN
  IF auth.uid() IS NULL OR public.get_user_role() NOT IN ('admin','production_supervisor') THEN
    RAISE EXCEPTION 'Production supervisor role required' USING ERRCODE='42501';
  END IF;
  IF jsonb_typeof(p_run) IS DISTINCT FROM 'object' OR
     jsonb_typeof(p_additional_outputs) IS DISTINCT FROM 'array' OR
     jsonb_array_length(p_additional_outputs) NOT BETWEEN 1 AND 19 OR
     jsonb_typeof(p_input_groups) IS DISTINCT FROM 'array' OR
     jsonb_array_length(p_input_groups) NOT BETWEEN 1 AND 20 THEN
    RAISE EXCEPTION 'Shared input logging requires 2-20 outputs and 1-20 groups';
  END IF;
  v_line_count:=1+jsonb_array_length(p_additional_outputs);
  SELECT stage INTO v_machine_stage FROM public.machines
    WHERE id=(p_run->>'machine_id')::uuid AND is_active;
  IF v_machine_stage IS DISTINCT FROM 'conversion'::public.machine_stage THEN
    RAISE EXCEPTION 'Shared inputs require an active conversion machine';
  END IF;

  -- Validate output units and measured output weights; any amount beyond the
  -- recorded group input is rejected, but waste/scrap may make input > output.
  FOR v_i IN 0..v_line_count-1 LOOP
    v_out:=CASE WHEN v_i=0 THEN p_run ELSE p_additional_outputs->(v_i-1) END;
    IF jsonb_typeof(v_out) IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'Invalid finished product output'; END IF;
    v_product_id:=(v_out->>'finished_good_id')::uuid;
    SELECT stage,unit INTO v_output_stage,v_output_unit
      FROM public.finished_goods WHERE id=v_product_id;
    IF v_output_stage IS DISTINCT FROM 'finished'::public.product_stage OR
       v_output_unit IS DISTINCT FROM (v_out->>'output_unit')::public.output_unit THEN
      RAISE EXCEPTION 'Every output must be a finished product with matching unit';
    END IF;
    IF v_output_unit='rolls' THEN
      IF jsonb_typeof(v_out->'roll_weights') IS DISTINCT FROM 'array' OR
         jsonb_array_length(v_out->'roll_weights') NOT BETWEEN 1 AND 1000 THEN
        RAISE EXCEPTION 'Finished rolls require individual measured weights'; END IF;
      SELECT SUM(w::numeric) INTO v_output_weight
        FROM jsonb_array_elements_text(v_out->'roll_weights') w;
      IF EXISTS (SELECT 1 FROM jsonb_array_elements_text(v_out->'roll_weights') w
        WHERE w::numeric<=0 OR w::numeric>500 OR w::numeric<>round(w::numeric,2)) THEN
        RAISE EXCEPTION 'Invalid individual output roll weight'; END IF;
    ELSIF v_output_unit='kg' THEN
      v_output_weight:=(v_out->>'output_quantity')::numeric;
    ELSE
      -- Bundle counts cannot be compared to kg. Their quantity is validated,
      -- and the source-group kg is still logged and deducted once.
      v_output_weight:=0;
    END IF;
    IF COALESCE((v_out->>'output_quantity')::numeric,0)<=0 OR
       (v_output_unit='rolls' AND (v_out->>'output_quantity')::numeric <> jsonb_array_length(v_out->'roll_weights')) OR
       v_output_weight<0 THEN RAISE EXCEPTION 'Invalid finished output quantity'; END IF;
  END LOOP;

  -- Validate exclusive group membership. Each output belongs to exactly one
  -- shared group, and each physical roll appears in at most one group.
  FOR v_i IN 0..v_line_count-1 LOOP
    SELECT COUNT(*) INTO v_input_count FROM jsonb_array_elements(p_input_groups) g,
      jsonb_array_elements_text(g->'output_indices') oi
      WHERE oi::integer=v_i;
    IF v_input_count<>1 THEN
      RAISE EXCEPTION 'Finished output % must belong to exactly one input group',v_i+1;
    END IF;
  END LOOP;
  FOR v_group IN SELECT value FROM jsonb_array_elements(p_input_groups) LOOP
    IF jsonb_typeof(v_group->'output_indices') IS DISTINCT FROM 'array' OR
       jsonb_array_length(v_group->'output_indices')<1 OR
       jsonb_typeof(v_group->'roll_allocations') IS DISTINCT FROM 'array' OR
       jsonb_array_length(v_group->'roll_allocations') NOT BETWEEN 1 AND 1000 THEN
      RAISE EXCEPTION 'Every group requires members and weighed source rolls'; END IF;
    v_input_id:=(v_group->>'input_product_id')::uuid;
    SELECT stage,unit,spec_thickness INTO v_input_stage,v_input_unit,v_input_micron
      FROM public.finished_goods WHERE id=v_input_id;
    IF v_input_stage IS DISTINCT FROM 'semi_finished'::public.product_stage OR
       v_input_unit IS DISTINCT FROM 'rolls'::public.output_unit THEN
      RAISE EXCEPTION 'Shared input must be a roll-counted semi-finished product'; END IF;
    v_total:=0;
    FOR v_part IN SELECT value FROM jsonb_array_elements(v_group->'roll_allocations') LOOP
      v_roll_id:=(v_part->>'roll_id')::uuid;
      v_roll_used:=(v_part->>'weight_kg')::numeric;
      IF v_roll_used IS NULL OR v_roll_used<=0 OR v_roll_used>500 OR v_roll_used<>round(v_roll_used,2) THEN
        RAISE EXCEPTION 'Consumed weight must be 0.01-500.00 kg with two decimal places'; END IF;
      IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_all_rolls) r
         WHERE (r->>'roll_id')::uuid=v_roll_id) THEN
        RAISE EXCEPTION 'A physical roll cannot be counted in two shared input groups'; END IF;
      v_all_rolls:=v_all_rolls || jsonb_build_array(jsonb_build_object(
        'roll_id',v_roll_id,'weight_kg',v_roll_used,'input_product_id',v_input_id));
      v_total:=v_total+v_roll_used;
    END LOOP;
    v_group_output_weight:=0;
    FOR v_index IN SELECT value::integer FROM jsonb_array_elements_text(v_group->'output_indices') LOOP
      IF v_index<0 OR v_index>=v_line_count THEN RAISE EXCEPTION 'Invalid output group member'; END IF;
      v_out:=CASE WHEN v_index=0 THEN p_run ELSE p_additional_outputs->(v_index-1) END;
      SELECT spec_thickness INTO v_output_micron FROM public.finished_goods
        WHERE id=(v_out->>'finished_good_id')::uuid;
      IF (v_input_micron IS NOT NULL AND v_output_micron IS NOT NULL AND ABS(v_input_micron-v_output_micron)>0.1) OR
         (v_input_micron IS NOT NULL AND NULLIF(v_out->>'film_thickness','') IS NOT NULL AND
          ABS(v_input_micron-(v_out->>'film_thickness')::numeric)>0.1) OR
         (v_output_micron IS NOT NULL AND NULLIF(v_out->>'film_thickness','') IS NOT NULL AND
          ABS(v_output_micron-(v_out->>'film_thickness')::numeric)>0.1) THEN
        RAISE EXCEPTION 'Input micron does not match a finished product in the group'; END IF;
      IF (v_out->>'output_unit')='rolls' THEN
        SELECT COALESCE(SUM(w::numeric),0) INTO v_output_weight FROM jsonb_array_elements_text(v_out->'roll_weights') w;
      ELSIF (v_out->>'output_unit')='kg' THEN
        v_output_weight:=(v_out->>'output_quantity')::numeric;
      ELSE v_output_weight:=0; END IF;
      v_group_output_weight:=v_group_output_weight+v_output_weight;
    END LOOP;
    IF v_group_output_weight>v_total+0.01 THEN
      RAISE EXCEPTION 'Finished output weight % kg exceeds shared group input % kg',v_group_output_weight,v_total;
    END IF;
  END LOOP;

  SELECT array_agg(DISTINCT (r->>'roll_id')::uuid) INTO v_roll_ids FROM jsonb_array_elements(v_all_rolls) r;
  PERFORM id FROM public.product_rolls WHERE id=ANY(v_roll_ids) ORDER BY id FOR UPDATE;
  IF (SELECT count(*) FROM public.product_rolls WHERE id=ANY(v_roll_ids))<>cardinality(v_roll_ids) THEN
    RAISE EXCEPTION 'Selected source roll does not exist'; END IF;
  FOR v_roll IN SELECT id,finished_good_id,weight_kg,micron,status
     FROM public.product_rolls WHERE id=ANY(v_roll_ids) LOOP
    SELECT (x->>'weight_kg')::numeric AS weight_kg,(x->>'input_product_id')::uuid AS input_id
      INTO v_roll_used,v_input_id FROM jsonb_array_elements(v_all_rolls) x WHERE (x->>'roll_id')::uuid=v_roll.id;
    SELECT spec_thickness INTO v_input_micron FROM public.finished_goods WHERE id=v_input_id;
    IF v_roll.status IS DISTINCT FROM 'available'::public.roll_status OR
       v_roll.finished_good_id<>v_input_id OR v_roll_used>v_roll.weight_kg OR
       (v_roll.micron IS NOT NULL AND v_input_micron IS NOT NULL AND ABS(v_roll.micron-v_input_micron)>0.1) THEN
      RAISE EXCEPTION 'Roll unavailable, insufficient, or micron mismatch; refresh inventory'; END IF;
    -- Also validate each physical roll's micron against every group output.
    IF v_roll.micron IS NOT NULL AND EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_input_groups) g,
        jsonb_array_elements_text(g->'output_indices') oi
        WHERE (g->>'input_product_id')::uuid=v_input_id
          AND EXISTS (SELECT 1 FROM jsonb_array_elements(g->'roll_allocations') a WHERE (a->>'roll_id')::uuid=v_roll.id)
          AND EXISTS (SELECT 1 FROM public.finished_goods fg WHERE fg.id=((CASE WHEN oi::integer=0 THEN p_run ELSE p_additional_outputs->(oi::integer-1) END)->>'finished_good_id')::uuid
            AND ((fg.spec_thickness IS NOT NULL AND ABS(fg.spec_thickness-v_roll.micron)>0.1) OR
              (NULLIF((CASE WHEN oi::integer=0 THEN p_run ELSE p_additional_outputs->(oi::integer-1) END)->>'film_thickness','') IS NOT NULL AND
               ABS(((CASE WHEN oi::integer=0 THEN p_run ELSE p_additional_outputs->(oi::integer-1) END)->>'film_thickness')::numeric-v_roll.micron)>0.1)))
    ) THEN RAISE EXCEPTION 'Physical source roll micron mismatches a finished output'; END IF;
  END LOOP;

  -- Use a shared-groups marker to bypass the legacy single-input stock debit.
  v_primary_group:=NULL;
  FOR v_group IN SELECT value FROM jsonb_array_elements(p_input_groups) LOOP
    IF v_group->'output_indices' @> '[0]'::jsonb THEN v_primary_group:=v_group; EXIT; END IF;
  END LOOP;
  v_primary_input:=(v_primary_group->>'input_product_id')::uuid;
  SELECT sum((a->>'weight_kg')::numeric) INTO v_primary_consumed
    FROM jsonb_array_elements(v_primary_group->'roll_allocations') a;
  v_row:=jsonb_populate_record(NULL::public.production_runs,p_run);
  v_row.input_product_id:=v_primary_input;
  v_row.input_quantity_consumed:=v_primary_consumed;
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
    v_row.samples_failed,v_row.qc_issues,v_row.qc_issue_other,v_row.batch_id,v_row.quality_grade,
    COALESCE(v_row.waste_quantity,0),v_row.notes,v_row.roll_weights,auth.uid(),'shared_groups'
  ) RETURNING id INTO v_run;

  FOR v_out IN SELECT value FROM jsonb_array_elements(p_additional_outputs) LOOP
    v_extra_row:=jsonb_populate_record(NULL::public.production_run_additional_outputs,v_out);
    INSERT INTO public.production_run_additional_outputs (
      production_run_id,finished_good_id,output_quantity,output_unit,roll_weights,
      film_thickness,film_width,film_color,batch_id,quality_grade,
      input_product_id,input_quantity_consumed
    ) VALUES (
      v_run,v_extra_row.finished_good_id,v_extra_row.output_quantity,v_extra_row.output_unit,
      v_extra_row.roll_weights,v_extra_row.film_thickness,v_extra_row.film_width,
      v_extra_row.film_color,v_extra_row.batch_id,v_extra_row.quality_grade,NULL,NULL
    ) RETURNING id INTO v_roll_id;
    v_extra_ids:=array_append(v_extra_ids,v_roll_id);
  END LOOP;

  FOR v_group IN SELECT value FROM jsonb_array_elements(p_input_groups) LOOP
    v_input_id:=(v_group->>'input_product_id')::uuid;
    SELECT sum((a->>'weight_kg')::numeric) INTO v_total
      FROM jsonb_array_elements(v_group->'roll_allocations') a;
    INSERT INTO public.production_run_input_groups(production_run_id,input_product_id,consumed_weight_kg)
      VALUES(v_run,v_input_id,v_total) RETURNING id INTO v_group_id;
    FOR v_index IN SELECT value::integer FROM jsonb_array_elements_text(v_group->'output_indices') LOOP
      INSERT INTO public.production_run_input_group_outputs(group_id,production_run_id,production_output_id)
        VALUES(v_group_id,v_run,CASE WHEN v_index=0 THEN NULL ELSE v_extra_ids[v_index] END);
    END LOOP;
    FOR v_part IN SELECT value FROM jsonb_array_elements(v_group->'roll_allocations') LOOP
      v_roll_id:=(v_part->>'roll_id')::uuid;
      v_roll_used:=(v_part->>'weight_kg')::numeric;
      INSERT INTO public.production_run_input_group_rolls(group_id,input_roll_id,consumed_weight_kg)
        VALUES(v_group_id,v_roll_id,v_roll_used);
    END LOOP;
  END LOOP;

  -- Each input roll appears in exactly one group. Partial leftover remains
  -- available; only complete depletion reduces roll-counted aggregate stock.
  FOR v_roll IN SELECT id,finished_good_id,weight_kg FROM public.product_rolls
      WHERE id=ANY(v_roll_ids) ORDER BY id LOOP
    SELECT (a->>'weight_kg')::numeric INTO v_roll_used
      FROM jsonb_array_elements(v_all_rolls) a WHERE (a->>'roll_id')::uuid=v_roll.id;
    v_left:=v_roll.weight_kg-v_roll_used;
    UPDATE public.product_rolls SET weight_kg=v_left,
      status=CASE WHEN v_left=0 THEN 'consumed'::public.roll_status ELSE 'available'::public.roll_status END,
      consumed_in_run_id=CASE WHEN v_left=0 THEN v_run ELSE consumed_in_run_id END,
      consumed_in_output_id=NULL WHERE id=v_roll.id;
    IF v_left=0 THEN
      UPDATE public.finished_goods SET current_stock=current_stock-1
        WHERE id=v_roll.finished_good_id AND current_stock>=1;
      IF NOT FOUND THEN RAISE EXCEPTION 'Semi-finished inventory count out of sync'; END IF;
      PERFORM public.record_stock_movement('finished',v_roll.finished_good_id,'out',1,
        'production_run',v_run,'Shared source roll depleted');
    END IF;
  END LOOP;
  RETURN v_run;
END $$;
REVOKE ALL ON FUNCTION public.post_shared_conversion_run(jsonb,jsonb,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.post_shared_conversion_run(jsonb,jsonb,jsonb) TO authenticated;
NOTIFY pgrst, 'reload schema';
