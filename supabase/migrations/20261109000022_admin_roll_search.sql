-- FactoryFlow Hardened: admin-only, paginated individual-roll search with
-- original production batch and date. Uses existing source-of-truth tables.
-- No new role privileges or duplicate batch fields are introduced.

CREATE INDEX IF NOT EXISTS idx_product_rolls_roll_no_desc
  ON public.product_rolls (roll_no DESC);

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
      pr.batch_id, pr.run_date AS production_date,
      pr.shift::text AS production_shift,
      pr.operator_name, pr.supervisor_name,
      pr.quality_grade, pr.notes AS production_notes,
      pr.process_type::text AS process_type,
      pr.created_at AS run_logged_at,
      m.name AS machine_name, m.machine_code
    FROM public.product_rolls r
    JOIN public.finished_goods fg ON fg.id = r.finished_good_id
    LEFT JOIN public.customers c ON c.id = fg.customer_id
    LEFT JOIN public.production_runs pr ON pr.id = r.production_run_id
    LEFT JOIN public.machines m ON m.id = pr.machine_id
    WHERE (v_status IS NULL OR r.status::text = v_status)
      AND (
        v_query = ''
        OR r.roll_no::text ILIKE '%' || v_query || '%'
        OR fg.product_name ILIKE '%' || v_query || '%'
        OR COALESCE(c.business_name, '') ILIKE '%' || v_query || '%'
        OR COALESCE(c.name, '') ILIKE '%' || v_query || '%'
        OR COALESCE(pr.batch_id, '') ILIKE '%' || v_query || '%'
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

REVOKE ALL ON FUNCTION public.search_inventory_rolls(TEXT, TEXT, INTEGER, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.search_inventory_rolls(TEXT, TEXT, INTEGER, INTEGER) TO authenticated;

COMMENT ON FUNCTION public.search_inventory_rolls(TEXT, TEXT, INTEGER, INTEGER)
IS 'Admin-only paginated roll search by roll number, product/brand, customer business, batch ID and production date. Returns production_runs.batch_id and run_date; never substitutes roll creation time.';
