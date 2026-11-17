-- Conversion runs may use a distinct semi-finished input for EVERY output line.
-- This is additive: retain old migration history and historical production records.
-- A NULL input on existing additional lines means it was not recorded separately.
ALTER TABLE public.production_run_additional_outputs
  ADD COLUMN input_product_id UUID REFERENCES public.finished_goods(id),
  ADD COLUMN input_quantity_consumed NUMERIC(12,2)
    CHECK (input_quantity_consumed IS NULL OR input_quantity_consumed > 0);

ALTER TABLE public.product_rolls
  ADD COLUMN consumed_in_output_id UUID REFERENCES public.production_run_additional_outputs(id);
CREATE INDEX idx_rolls_consumed_in_output ON public.product_rolls(consumed_in_output_id)
  WHERE consumed_in_output_id IS NOT NULL;
CREATE INDEX idx_additional_outputs_input_product ON public.production_run_additional_outputs(input_product_id)
  WHERE input_product_id IS NOT NULL;

-- Keep a separate input allocation and stock movement for each extra output.
-- The original primary production_run still posts its own semi-finished input.
-- Any failure rolls back ALL output credits, input debits, and physical-roll changes.
CREATE OR REPLACE FUNCTION public.post_multi_production_run(
  p_run JSONB, p_materials JSONB, p_additional_outputs JSONB
) RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
  v_run UUID;
  v_extra_id UUID;
  v_stage public.machine_stage;
  v_expected public.product_stage;
  v_output_stage public.product_stage;
  v_output_unit public.output_unit;
  v_output_micron NUMERIC;
  v_input_stage public.product_stage;
  v_input_unit public.output_unit;
  v_input_stock NUMERIC;
  v_input_micron NUMERIC;
  v_primary_input_micron NUMERIC;
  v_primary_output_micron NUMERIC;
  v_input_id UUID;
  v_quantity NUMERIC;
  v_input_rolls UUID[];
  v_primary_roll_ids UUID[];
  v_nrolls INTEGER;
  v_locked INTEGER;
  v_updated INTEGER;
  v_extra JSONB;
  v_row public.production_run_additional_outputs%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR public.get_user_role() NOT IN ('admin','production_supervisor') THEN
    RAISE EXCEPTION 'Production supervisor role required' USING ERRCODE='42501';
  END IF;
  IF jsonb_typeof(p_run) IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_materials) IS DISTINCT FROM 'array'
     OR jsonb_typeof(p_additional_outputs) IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_additional_outputs) NOT BETWEEN 1 AND 19 THEN
    RAISE EXCEPTION 'Provide a primary output and 1-19 additional output lines';
  END IF;
  SELECT stage INTO v_stage FROM public.machines
    WHERE id=(p_run->>'machine_id')::uuid AND is_active;
  IF v_stage IS NULL THEN RAISE EXCEPTION 'Select an active machine'; END IF;
  v_expected:=CASE WHEN v_stage='conversion' THEN 'finished'::public.product_stage
                   ELSE 'semi_finished'::public.product_stage END;
  SELECT stage,unit,spec_thickness INTO v_output_stage,v_output_unit,v_primary_output_micron
    FROM public.finished_goods WHERE id=(p_run->>'finished_good_id')::uuid;
  IF v_output_stage IS DISTINCT FROM v_expected
     OR v_output_unit IS DISTINCT FROM (p_run->>'output_unit')::public.output_unit THEN
    RAISE EXCEPTION 'Primary output must be a % product with matching unit',v_expected;
  END IF;
  IF v_stage='conversion' THEN
    SELECT spec_thickness INTO v_primary_input_micron
      FROM public.finished_goods WHERE id=(p_run->>'input_product_id')::uuid AND stage='semi_finished';
    IF NOT FOUND THEN RAISE EXCEPTION 'Select a semi-finished input for the primary output'; END IF;
    IF (v_primary_input_micron IS NOT NULL AND v_primary_output_micron IS NOT NULL
        AND ABS(v_primary_input_micron-v_primary_output_micron)>0.1)
       OR (v_primary_input_micron IS NOT NULL AND (p_run->>'film_thickness') IS NOT NULL
        AND ABS(v_primary_input_micron-(p_run->>'film_thickness')::numeric)>0.1)
       OR (v_primary_output_micron IS NOT NULL AND (p_run->>'film_thickness') IS NOT NULL
        AND ABS(v_primary_output_micron-(p_run->>'film_thickness')::numeric)>0.1) THEN
      RAISE EXCEPTION 'Primary input and finished product micron specifications do not match';
    END IF;
    v_primary_roll_ids:=ARRAY(SELECT jsonb_array_elements_text(COALESCE(p_run->'input_roll_ids','[]'::jsonb))::uuid);
    IF EXISTS (
      SELECT 1 FROM public.product_rolls r
      WHERE r.id=ANY(v_primary_roll_ids) AND r.micron IS NOT NULL
        AND (
          (v_primary_input_micron IS NOT NULL AND ABS(r.micron-v_primary_input_micron)>0.1)
          OR (v_primary_output_micron IS NOT NULL AND ABS(r.micron-v_primary_output_micron)>0.1)
          OR ((p_run->>'film_thickness') IS NOT NULL AND ABS(r.micron-(p_run->>'film_thickness')::numeric)>0.1)
        )
    ) THEN
      RAISE EXCEPTION 'A selected primary input roll has the wrong micron thickness';
    END IF;
  END IF;

  -- Validate all additional products and their stage BEFORE primary posting.
  FOR v_extra IN SELECT value FROM jsonb_array_elements(p_additional_outputs) LOOP
    IF jsonb_typeof(v_extra) IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'Invalid additional output line';
    END IF;
    v_row:=jsonb_populate_record(NULL::public.production_run_additional_outputs,v_extra);
    IF v_row.finished_good_id IS NULL OR v_row.output_quantity IS NULL OR v_row.output_quantity<=0 THEN
      RAISE EXCEPTION 'Each additional output needs a product and positive quantity';
    END IF;
    SELECT stage,unit,spec_thickness INTO v_output_stage,v_output_unit,v_output_micron
      FROM public.finished_goods WHERE id=v_row.finished_good_id;
    IF v_output_stage IS DISTINCT FROM v_expected OR v_output_unit IS DISTINCT FROM v_row.output_unit THEN
      RAISE EXCEPTION 'Additional output must be a % product with matching unit',v_expected;
    END IF;
    IF v_stage='conversion' THEN
      IF v_row.input_product_id IS NULL THEN
        RAISE EXCEPTION 'Every finished output must select its own semi-finished input';
      END IF;
      SELECT stage,spec_thickness INTO v_input_stage,v_input_micron
        FROM public.finished_goods WHERE id=v_row.input_product_id;
      IF v_input_stage IS DISTINCT FROM 'semi_finished'::public.product_stage THEN
        RAISE EXCEPTION 'Only semi-finished products can be used for conversion inputs';
      END IF;
      IF (v_input_micron IS NOT NULL AND v_output_micron IS NOT NULL
          AND ABS(v_input_micron-v_output_micron)>0.1)
         OR (v_input_micron IS NOT NULL AND v_row.film_thickness IS NOT NULL
          AND ABS(v_input_micron-v_row.film_thickness)>0.1)
         OR (v_output_micron IS NOT NULL AND v_row.film_thickness IS NOT NULL
          AND ABS(v_output_micron-v_row.film_thickness)>0.1) THEN
        RAISE EXCEPTION 'Additional output input and finished product micron specifications do not match';
      END IF;
    ELSIF v_extra ? 'input_product_id' OR v_extra ? 'input_roll_ids'
       OR v_extra ? 'input_quantity_consumed' THEN
      RAISE EXCEPTION 'Extrusion output lines cannot consume semi-finished inputs';
    END IF;
  END LOOP;

  -- The original primary input is deducted by its existing audited trigger.
  v_run:=public.post_production_run(p_run,p_materials);

  FOR v_extra IN SELECT value FROM jsonb_array_elements(p_additional_outputs) LOOP
    v_row:=jsonb_populate_record(NULL::public.production_run_additional_outputs,v_extra);
    v_input_id:=NULL;
    v_quantity:=NULL;
    v_input_rolls:=ARRAY[]::UUID[];

    IF v_stage='conversion' THEN
      v_input_id:=v_row.input_product_id;
      -- Lock input stock before validating and posting the individual debit.
      SELECT stage,unit,current_stock INTO v_input_stage,v_input_unit,v_input_stock
        FROM public.finished_goods WHERE id=v_input_id FOR UPDATE;
      IF v_input_stage IS DISTINCT FROM 'semi_finished'::public.product_stage THEN
        RAISE EXCEPTION 'Select a valid semi-finished input for every output';
      END IF;
      IF v_extra ? 'input_roll_ids' AND jsonb_typeof(v_extra->'input_roll_ids') IS DISTINCT FROM 'array' THEN
        RAISE EXCEPTION 'Input roll IDs must be an array';
      END IF;
      v_input_rolls:=ARRAY(SELECT jsonb_array_elements_text(COALESCE(v_extra->'input_roll_ids','[]'::jsonb))::uuid);
      v_nrolls:=COALESCE(cardinality(v_input_rolls),0);
      IF v_input_unit='rolls' THEN
        IF v_nrolls NOT BETWEEN 1 AND 1000 OR
           v_nrolls IS DISTINCT FROM (SELECT COUNT(DISTINCT roll_id) FROM unnest(v_input_rolls) AS t(roll_id)) THEN
          RAISE EXCEPTION 'Select 1-1000 distinct physical input rolls for each output';
        END IF;
        SELECT count(*) INTO v_locked FROM (
          SELECT id FROM public.product_rolls
          WHERE id=ANY(v_input_rolls) AND finished_good_id=v_input_id AND status='available'
          FOR UPDATE
        ) available;
        IF v_locked<>v_nrolls THEN
          RAISE EXCEPTION 'A selected input roll is no longer available or belongs to another product';
        END IF;
        SELECT spec_thickness INTO v_input_micron FROM public.finished_goods WHERE id=v_input_id;
        SELECT spec_thickness INTO v_output_micron FROM public.finished_goods WHERE id=v_row.finished_good_id;
        IF EXISTS (
          SELECT 1 FROM public.product_rolls r
          WHERE r.id=ANY(v_input_rolls) AND r.micron IS NOT NULL
            AND (
              (v_input_micron IS NOT NULL AND ABS(r.micron-v_input_micron)>0.1)
              OR (v_output_micron IS NOT NULL AND ABS(r.micron-v_output_micron)>0.1)
              OR (v_row.film_thickness IS NOT NULL AND ABS(r.micron-v_row.film_thickness)>0.1)
            )
        ) THEN
          RAISE EXCEPTION 'A selected additional input roll has the wrong micron thickness';
        END IF;
        v_quantity:=v_nrolls;
      ELSE
        IF v_nrolls<>0 THEN RAISE EXCEPTION 'Physical roll IDs are only for roll-counted inputs'; END IF;
        v_quantity:=v_row.input_quantity_consumed;
        IF v_quantity IS NULL OR v_quantity<=0 THEN
          RAISE EXCEPTION 'Enter a positive consumed quantity for each additional output';
        END IF;
      END IF;
      IF v_input_stock<v_quantity THEN
        RAISE EXCEPTION 'Insufficient semi-finished input stock for product %: available %, requested %',
          v_input_id,v_input_stock,v_quantity;
      END IF;
    END IF;

    INSERT INTO public.production_run_additional_outputs(
      production_run_id,finished_good_id,output_quantity,output_unit,roll_weights,
      film_thickness,film_width,film_color,batch_id,quality_grade,
      input_product_id,input_quantity_consumed)
    VALUES(v_run,v_row.finished_good_id,v_row.output_quantity,v_row.output_unit,v_row.roll_weights,
      v_row.film_thickness,v_row.film_width,v_row.film_color,v_row.batch_id,v_row.quality_grade,
      v_input_id,v_quantity)
    RETURNING id INTO v_extra_id;

    IF v_stage='conversion' THEN
      UPDATE public.finished_goods
        SET current_stock=current_stock-v_quantity WHERE id=v_input_id;
      PERFORM public.record_stock_movement('finished',v_input_id,'out',v_quantity,
        'production_run',v_run,'Semi-finished input for output '||v_extra_id::text);
      IF v_input_unit='rolls' THEN
        UPDATE public.product_rolls
          SET status='consumed', consumed_in_run_id=v_run, consumed_in_output_id=v_extra_id
          WHERE id=ANY(v_input_rolls) AND status='available' AND finished_good_id=v_input_id;
        GET DIAGNOSTICS v_updated=ROW_COUNT;
        IF v_updated<>v_nrolls THEN
          RAISE EXCEPTION 'Input roll allocation changed; production run rolled back';
        END IF;
      END IF;
    END IF;
  END LOOP;
  RETURN v_run;
END;
$$;
REVOKE ALL ON FUNCTION public.post_multi_production_run(JSONB,JSONB,JSONB) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.post_multi_production_run(JSONB,JSONB,JSONB) TO authenticated;

COMMENT ON COLUMN public.production_run_additional_outputs.input_product_id IS
  'Semi-finished input consumed specifically for this additional conversion output, not the shared primary input.';
COMMENT ON COLUMN public.product_rolls.consumed_in_output_id IS
  'Additional conversion output that consumed this specific roll; NULL for primary/legacy input consumption.';
NOTIFY pgrst, 'reload schema';
