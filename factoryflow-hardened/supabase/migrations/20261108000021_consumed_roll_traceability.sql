-- Physical traceability for roll inputs consumed by cutting or printing runs.
ALTER TYPE public.roll_status ADD VALUE IF NOT EXISTS 'consumed';
ALTER TABLE public.product_rolls ADD COLUMN consumed_in_run_id UUID REFERENCES public.production_runs(id);

-- A physical roll is on hand if available or reserved; sold/consumed are not stock.
CREATE OR REPLACE VIEW public.roll_stock_discrepancies WITH (security_invoker=true) AS
SELECT fg.id,fg.product_name,fg.current_stock AS recorded_stock,
  (SELECT COUNT(*) FROM product_rolls pr WHERE pr.finished_good_id=fg.id
    AND pr.status IN ('available','reserved')) AS counted_rolls
FROM finished_goods fg WHERE fg.unit='rolls'
  AND fg.current_stock <> (SELECT COUNT(*) FROM product_rolls pr WHERE pr.finished_good_id=fg.id
    AND pr.status IN ('available','reserved'));

CREATE OR REPLACE FUNCTION public.post_production_run(p_run JSONB,p_materials JSONB DEFAULT '[]'::jsonb)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_run UUID; v_stage machine_stage; v_material JSONB; v_count INTEGER :=0; v_rec production_runs%ROWTYPE;
  v_input_rolls UUID[]; v_count_rolls INTEGER; v_input_unit output_unit; v_output_unit output_unit;
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
  SELECT unit INTO v_output_unit FROM finished_goods WHERE id=v_rec.finished_good_id;
  IF v_output_unit IS NULL THEN RAISE EXCEPTION 'An output product is required'; END IF;
  IF v_output_unit='rolls' AND (v_rec.roll_weights IS NULL OR cardinality(v_rec.roll_weights)=0) THEN
    RAISE EXCEPTION 'Roll outputs require measured weight for each physical roll'; END IF;
  IF v_output_unit='kg' AND v_rec.output_unit='rolls' THEN
    RAISE EXCEPTION 'Kilogram products cannot be recorded using roll counts'; END IF;
  v_input_rolls:=ARRAY(SELECT jsonb_array_elements_text(COALESCE(p_run->'input_roll_ids','[]'::jsonb))::uuid);
  IF v_stage='conversion' THEN
    SELECT unit INTO v_input_unit FROM finished_goods WHERE id=v_rec.input_product_id;
    IF v_input_unit='rolls' THEN
      IF cardinality(v_input_rolls)=0 OR cardinality(v_input_rolls)<>(SELECT COUNT(DISTINCT x) FROM unnest(v_input_rolls)x) THEN
        RAISE EXCEPTION 'Select distinct physical input rolls'; END IF;
      -- Lock the input product as well as the physical rolls to serialize concurrent conversions.
      PERFORM 1 FROM finished_goods WHERE id=v_rec.input_product_id FOR UPDATE;
      SELECT COUNT(*) INTO v_count_rolls FROM (
        SELECT id FROM product_rolls
        WHERE id=ANY(v_input_rolls) AND finished_good_id=v_rec.input_product_id AND status='available'
        FOR UPDATE) available;
      IF v_count_rolls<>cardinality(v_input_rolls) THEN
        RAISE EXCEPTION 'Selected input roll is unavailable'; END IF;
      v_rec.input_quantity_consumed:=cardinality(v_input_rolls);
    ELSIF cardinality(v_input_rolls)>0 THEN
      RAISE EXCEPTION 'Input roll IDs are only for roll-counted input';
    END IF;
  ELSIF cardinality(v_input_rolls)>0 THEN
    RAISE EXCEPTION 'Extrusion does not consume semi-finished physical rolls';
  END IF;
  INSERT INTO production_runs (run_date,shift,machine_id,operator_name,finished_good_id,film_thickness,film_width,film_color,output_quantity,output_unit,input_product_id,input_quantity_consumed,supervisor_name,process_type,formula_code,roll_count,roll_length,avg_weight_per_roll,start_time,end_time,total_runtime_hours,downtime_hours,temp_z1,temp_z2,temp_z3,temp_z4,temp_z5,temp_z6,screw_speed_rpm,line_speed_mpm,cut_length_mm,bottom_seal_offset_mm,cutting_speed_cpm,print_colours_count,print_speed,print_tension,cleaned_rollers,roll_edges_ok,neatness_rating,samples_tested,samples_passed,samples_failed,qc_issues,qc_issue_other,batch_id,quality_grade,waste_quantity,notes,roll_weights,created_by)
  VALUES (COALESCE(v_rec.run_date,CURRENT_DATE),v_rec.shift,v_rec.machine_id,v_rec.operator_name,v_rec.finished_good_id,v_rec.film_thickness,v_rec.film_width,v_rec.film_color,v_rec.output_quantity,COALESCE(v_rec.output_unit,'kg'::output_unit),v_rec.input_product_id,COALESCE(v_rec.input_quantity_consumed,0),v_rec.supervisor_name,v_rec.process_type,v_rec.formula_code,v_rec.roll_count,v_rec.roll_length,v_rec.avg_weight_per_roll,v_rec.start_time,v_rec.end_time,v_rec.total_runtime_hours,COALESCE(v_rec.downtime_hours,0),v_rec.temp_z1,v_rec.temp_z2,v_rec.temp_z3,v_rec.temp_z4,v_rec.temp_z5,v_rec.temp_z6,v_rec.screw_speed_rpm,v_rec.line_speed_mpm,v_rec.cut_length_mm,v_rec.bottom_seal_offset_mm,v_rec.cutting_speed_cpm,v_rec.print_colours_count,v_rec.print_speed,v_rec.print_tension,v_rec.cleaned_rollers,v_rec.roll_edges_ok,v_rec.neatness_rating,v_rec.samples_tested,v_rec.samples_passed,v_rec.samples_failed,v_rec.qc_issues,v_rec.qc_issue_other,v_rec.batch_id,v_rec.quality_grade,COALESCE(v_rec.waste_quantity,0),v_rec.notes,v_rec.roll_weights,auth.uid()) RETURNING id INTO v_run;
  IF cardinality(v_input_rolls)>0 THEN
    UPDATE product_rolls SET status='consumed',consumed_in_run_id=v_run
      WHERE id=ANY(v_input_rolls) AND status='available';
    IF NOT FOUND THEN RAISE EXCEPTION 'Input roll allocation failed'; END IF;
  END IF;
  FOR v_material IN SELECT * FROM jsonb_array_elements(p_materials) LOOP
    IF (v_material->>'quantity_kg')::numeric<=0 THEN RAISE EXCEPTION 'Invalid material quantity'; END IF;
    INSERT INTO production_run_materials(production_run_id,raw_material_id,quantity_kg,proportion_pct)
    VALUES(v_run,(v_material->>'raw_material_id')::uuid,(v_material->>'quantity_kg')::numeric,
      (v_material->>'proportion_pct')::numeric);
    v_count:=v_count+1;
  END LOOP;
  RETURN v_run;
END; $$;

-- Registration supports records produced before individual-roll tracking existed.
CREATE OR REPLACE FUNCTION public.register_legacy_rolls(p_finished_good UUID,
  p_weights NUMERIC[],p_micron NUMERIC DEFAULT NULL)
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_recorded NUMERIC; v_actual INTEGER; v_weight NUMERIC; v_idx INTEGER; v_unit output_unit;
BEGIN
  IF auth.uid() IS NULL OR get_user_role() NOT IN ('admin','production_supervisor') THEN
    RAISE EXCEPTION 'Inventory supervisor required'; END IF;
  IF cardinality(p_weights) IS NULL OR cardinality(p_weights)=0 OR cardinality(p_weights)>1000 THEN
    RAISE EXCEPTION 'Enter the measured weight of each missing physical roll'; END IF;
  IF EXISTS(SELECT 1 FROM unnest(p_weights) w WHERE w IS NULL OR w<=0 OR w>500) THEN
    RAISE EXCEPTION 'Every roll must weigh between 0 and 500 kg'; END IF;
  SELECT current_stock,unit INTO v_recorded,v_unit FROM finished_goods WHERE id=p_finished_good FOR UPDATE;
  IF NOT FOUND OR v_unit<>'rolls' THEN RAISE EXCEPTION 'Not a roll-counted product'; END IF;
  SELECT COUNT(*) INTO v_actual FROM product_rolls
    WHERE finished_good_id=p_finished_good AND status IN ('available','reserved');
  IF v_recorded<>TRUNC(v_recorded) OR v_recorded-v_actual<>cardinality(p_weights) THEN
    RAISE EXCEPTION 'Expected % missing rolls; provided %. Recheck the physical count',
      v_recorded-v_actual,cardinality(p_weights); END IF;
  FOR v_idx IN SELECT generate_subscripts(p_weights,1) LOOP
    v_weight:=p_weights[v_idx];
    INSERT INTO product_rolls(finished_good_id,weight_kg,micron,status)
      VALUES(p_finished_good,v_weight,p_micron,'available');
  END LOOP;
  -- Aggregate stock remains unchanged: these rolls were already counted in it.
  RETURN cardinality(p_weights);
END; $$;
