-- Attendance, payroll, and role-aware aggregate metrics.
-- Attendance timestamps are Ghana local +00:00, stored as TIMESTAMPTZ.
ALTER TABLE public.attendance ADD COLUMN IF NOT EXISTS clock_in_at TIMESTAMPTZ;
ALTER TABLE public.attendance ADD COLUMN IF NOT EXISTS clock_out_at TIMESTAMPTZ;
ALTER TABLE public.attendance ADD CONSTRAINT attendance_clock_interval_valid CHECK(
  clock_out_at IS NULL OR (clock_in_at IS NOT NULL AND clock_out_at>=clock_in_at AND clock_out_at<=clock_in_at+INTERVAL '24 hours'));
-- Existing time-only records are kept for history. New writes use timestamp columns.
CREATE OR REPLACE FUNCTION public.attendance_hours(p_in TIMESTAMPTZ,p_out TIMESTAMPTZ)
RETURNS NUMERIC LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN p_in IS NULL OR p_out IS NULL THEN NULL
   ELSE ROUND((EXTRACT(EPOCH FROM (p_out-p_in))/3600)::NUMERIC,2) END
$$;

-- Clock operations are server-timestamped and do not expose attendance editing.
DROP POLICY IF EXISTS "Staff manage own attendance" ON public.attendance;
CREATE POLICY "Staff see own attendance" ON public.attendance FOR SELECT
  USING (get_user_role()='staff' AND employee_id IN (SELECT id FROM employees WHERE profile_id=auth.uid()));
REVOKE INSERT,UPDATE,DELETE ON public.attendance FROM authenticated;
CREATE OR REPLACE FUNCTION public.staff_clock(p_action TEXT)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_employee UUID; v_today DATE:= (now() AT TIME ZONE 'Africa/Accra')::date;
  v_open attendance%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR get_user_role()<>'staff' THEN RAISE EXCEPTION 'Staff account required'; END IF;
  SELECT id INTO v_employee FROM employees WHERE profile_id=auth.uid() AND is_active LIMIT 1;
  IF v_employee IS NULL THEN RAISE EXCEPTION 'Active employee profile required'; END IF;
  -- Support overnight shifts: close the last open session from yesterday or today.
  SELECT * INTO v_open FROM attendance WHERE employee_id=v_employee AND clock_in_at IS NOT NULL AND clock_out_at IS NULL
    ORDER BY clock_in_at DESC LIMIT 1 FOR UPDATE;
  IF p_action='in' THEN
    IF v_open.id IS NOT NULL THEN RAISE EXCEPTION 'Already clocked in'; END IF;
    INSERT INTO attendance(employee_id,attendance_date,clock_in,clock_in_at,recorded_by)
    VALUES(v_employee,v_today,(now() AT TIME ZONE 'Africa/Accra')::time,now(),auth.uid());
  ELSIF p_action='out' THEN
    IF v_open.id IS NULL THEN RAISE EXCEPTION 'Clock in first'; END IF;
    UPDATE attendance SET clock_out_at=now(),clock_out=(now() AT TIME ZONE 'Africa/Accra')::time WHERE id=v_open.id;
  ELSE RAISE EXCEPTION 'Unknown clock action'; END IF;
END; $$;
REVOKE ALL ON FUNCTION public.staff_clock(TEXT) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.staff_clock(TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION public.hr_log_attendance(p_employee UUID,p_date DATE,p_in TEXT,p_out TEXT,p_notes TEXT)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_start TIMESTAMPTZ; v_end TIMESTAMPTZ;
BEGIN
  IF auth.uid() IS NULL OR get_user_role() NOT IN ('admin','hr_officer') THEN RAISE EXCEPTION 'HR role required'; END IF;
  IF p_in IS NULL OR p_in='' THEN RAISE EXCEPTION 'Clock-in time required'; END IF;
  v_start:=(p_date::text||' '||p_in||'+00')::timestamptz;
  IF p_out IS NOT NULL AND p_out<>'' THEN
    v_end:=(p_date::text||' '||p_out||'+00')::timestamptz;
    IF v_end<v_start THEN v_end:=v_end+INTERVAL '1 day'; END IF;
  END IF;
  INSERT INTO attendance(employee_id,attendance_date,clock_in,clock_out,clock_in_at,clock_out_at,notes,recorded_by)
  VALUES(p_employee,p_date,p_in::time,NULLIF(p_out,'')::time,v_start,v_end,p_notes,auth.uid())
  ON CONFLICT (employee_id,attendance_date) DO UPDATE SET
    clock_in=EXCLUDED.clock_in,clock_out=EXCLUDED.clock_out,clock_in_at=EXCLUDED.clock_in_at,
    clock_out_at=EXCLUDED.clock_out_at,notes=EXCLUDED.notes,recorded_by=auth.uid();
END; $$;
REVOKE ALL ON FUNCTION public.hr_log_attendance(UUID,DATE,TEXT,TEXT,TEXT) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.hr_log_attendance(UUID,DATE,TEXT,TEXT,TEXT) TO authenticated;

-- Payroll is calculated from verified attendance and employee terms in one transaction.
REVOKE INSERT, UPDATE, DELETE ON public.payroll_records FROM authenticated;
CREATE OR REPLACE FUNCTION public.generate_payroll(p_employee UUID,p_month INTEGER,p_year INTEGER,p_deductions NUMERIC,p_notes TEXT)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_emp employees%ROWTYPE; v_days NUMERIC; v_hours NUMERIC; v_gross NUMERIC; v_id UUID;
BEGIN
  IF auth.uid() IS NULL OR get_user_role() NOT IN ('admin','hr_officer') THEN RAISE EXCEPTION 'HR permission required'; END IF;
  IF p_month<1 OR p_month>12 OR p_year<2000 OR p_year>2100 THEN RAISE EXCEPTION 'Invalid payroll period'; END IF;
  SELECT * INTO v_emp FROM employees WHERE id=p_employee FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Employee not found'; END IF;
  SELECT COUNT(*),COALESCE(SUM(attendance_hours(clock_in_at,clock_out_at)),0)
    INTO v_days,v_hours FROM attendance WHERE employee_id=p_employee
    AND attendance_date>=make_date(p_year,p_month,1)
    AND attendance_date<(make_date(p_year,p_month,1)+INTERVAL '1 month')::date
    AND clock_in_at IS NOT NULL AND clock_out_at IS NOT NULL;
  v_gross:=CASE v_emp.rate_type WHEN 'monthly' THEN COALESCE(v_emp.salary_rate,0)
    WHEN 'hourly' THEN COALESCE(v_emp.wage_rate,0)*v_hours
    ELSE COALESCE(v_emp.wage_rate,0)*v_days END;
  v_gross:=ROUND(v_gross,2);
  IF v_gross<=0 OR p_deductions<0 OR p_deductions>v_gross THEN
    RAISE EXCEPTION 'Invalid payroll: check attendance, salary rate and deductions'; END IF;
  INSERT INTO payroll_records(employee_id,period_month,period_year,days_worked,hours_worked,gross_pay,deductions,notes,created_by)
  VALUES(p_employee,p_month,p_year,v_days,v_hours,v_gross,p_deductions,p_notes,auth.uid()) RETURNING id INTO v_id;
  RETURN v_id;
END; $$;
REVOKE ALL ON FUNCTION public.generate_payroll(UUID,INTEGER,INTEGER,NUMERIC,TEXT) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.generate_payroll(UUID,INTEGER,INTEGER,NUMERIC,TEXT) TO authenticated;

-- Aggregated monthly dashboard avoids fetching entire tables and never mixes rolls with kg.
CREATE OR REPLACE FUNCTION public.dashboard_metrics(p_month DATE DEFAULT CURRENT_DATE)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_from DATE:=date_trunc('month',p_month)::date; v_until DATE:=(date_trunc('month',p_month)+INTERVAL '1 month')::date;
  v_out JSONB:='{}'::jsonb; v_material NUMERIC; v_output NUMERIC; v_waste NUMERIC;
BEGIN
  IF auth.uid() IS NULL OR get_user_role() IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF get_user_role() IN ('admin','production_supervisor') THEN
    SELECT COALESCE(SUM(CASE WHEN pr.output_unit='kg' THEN pr.output_quantity
       ELSE (SELECT COALESCE(SUM(w),0) FROM unnest(pr.roll_weights) w) END),0),
      COALESCE(SUM(pr.waste_quantity),0) INTO v_output,v_waste
    FROM production_runs pr JOIN machines m ON m.id=pr.machine_id
    WHERE m.stage='extrusion' AND pr.run_date>=v_from AND pr.run_date<v_until;
    SELECT COALESCE(SUM(prm.quantity_kg),0) INTO v_material
    FROM production_run_materials prm JOIN production_runs pr ON pr.id=prm.production_run_id
    JOIN machines m ON m.id=pr.machine_id
    WHERE m.stage='extrusion' AND pr.run_date>=v_from AND pr.run_date<v_until;
    v_out:=v_out||jsonb_build_object('output_kg',v_output,
      'roll_count',(SELECT COALESCE(SUM(output_quantity),0) FROM production_runs WHERE run_date>=v_from AND run_date<v_until AND output_unit='rolls'),
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
          SUM(CASE WHEN pr.output_unit='kg' THEN pr.output_quantity
            ELSE (SELECT COALESCE(SUM(w),0) FROM unnest(pr.roll_weights) w) END) output
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
