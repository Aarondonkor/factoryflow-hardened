-- Release follow-up: historically recorded aggregate roll stock needs a verified
-- physical count. NEVER invent weights or generate anonymous fake rolls.
DROP POLICY IF EXISTS "Staff read rolls" ON public.product_rolls;
CREATE POLICY "Sales read rolls" ON public.product_rolls FOR SELECT
  USING (get_user_role() = 'sales_staff');
CREATE OR REPLACE VIEW public.low_stock_materials WITH (security_invoker=true) AS
  SELECT id,name,current_stock,reorder_threshold,unit,'raw'::text AS material_type
  FROM public.raw_materials WHERE current_stock <= reorder_threshold AND reorder_threshold > 0;

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
    WHERE finished_good_id=p_finished_good AND status<>'sold';
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
REVOKE ALL ON FUNCTION public.register_legacy_rolls(UUID,NUMERIC[],NUMERIC) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.register_legacy_rolls(UUID,NUMERIC[],NUMERIC) TO authenticated;

-- Limit concurrent HR clock-ins to one open session per employee, across dates.
CREATE UNIQUE INDEX IF NOT EXISTS idx_attendance_one_open_clock
  ON public.attendance(employee_id) WHERE clock_in_at IS NOT NULL AND clock_out_at IS NULL;
