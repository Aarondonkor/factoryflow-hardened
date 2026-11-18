-- Customer review segregation, access revocation and audited deletion.
-- Install after 029. No existing customer records are automatically removed.

CREATE TABLE IF NOT EXISTS public.rejected_customer_deletion_log (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 customer_id uuid NOT NULL,
 owner_auth_user_id uuid,
 deleted_by uuid NOT NULL,
 deleted_at timestamptz NOT NULL DEFAULT now(),
 auth_deleted_at timestamptz
);
ALTER TABLE public.rejected_customer_deletion_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.rejected_customer_deletion_log FROM PUBLIC, anon, authenticated;

-- Customer approval restrictions are enforced in the database, not solely in React.
-- Restrictive SELECT policies combine with existing permissive ownership policies.
DO $$ DECLARE table_name text; BEGIN
 FOREACH table_name IN ARRAY ARRAY['finished_goods','product_rolls','orders','order_items','payments','payment_attempts'] LOOP
   EXECUTE format('DROP POLICY IF EXISTS rejected_customer_read_guard ON public.%I',table_name);
   EXECUTE format($policy$CREATE POLICY rejected_customer_read_guard ON public.%I
     AS RESTRICTIVE FOR SELECT TO authenticated USING (
       public.get_user_role() IS DISTINCT FROM 'customer'::public.user_role
       OR EXISTS(SELECT 1 FROM public.customers c WHERE c.owner_profile_id=auth.uid() AND c.approval_status='approved')
     )$policy$,table_name);
 END LOOP;
END $$;

-- Restrict writes even if an older customer INSERT policy is still permissive.
DO $$ DECLARE table_name text; BEGIN
 FOREACH table_name IN ARRAY ARRAY['orders','order_items','payments'] LOOP
   EXECUTE format('DROP POLICY IF EXISTS rejected_customer_insert_guard ON public.%I',table_name);
   EXECUTE format($policy$CREATE POLICY rejected_customer_insert_guard ON public.%I
     AS RESTRICTIVE FOR INSERT TO authenticated WITH CHECK (
       public.get_user_role() IS DISTINCT FROM 'customer'::public.user_role
       OR EXISTS(SELECT 1 FROM public.customers c WHERE c.owner_profile_id=auth.uid() AND c.approval_status='approved')
     )$policy$,table_name);
 END LOOP;
END $$;

-- Preserve the existing stock RPC contract but deny rejected account access.
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
  WHERE c.owner_profile_id=auth.uid() AND c.approval_status='approved';
  IF v_customer IS NULL THEN RAISE EXCEPTION 'Approved customer account required'; END IF;
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


-- Permanently remove only an application with no references to business records.
-- Check all direct foreign keys against customers, not just today's known tables.
CREATE OR REPLACE FUNCTION public.admin_delete_rejected_customer(p_customer uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_owner uuid; v_fk record; v_found boolean; v_column text;
BEGIN
 IF auth.uid() IS NULL OR public.get_user_role()<>'admin' THEN
   RAISE EXCEPTION 'Administrator permission required' USING ERRCODE='42501'; END IF;
 SELECT owner_profile_id INTO v_owner FROM public.customers
 WHERE id=p_customer AND approval_status='rejected' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Only rejected registrations may be deleted'; END IF;
 FOR v_fk IN
   SELECT con.conrelid, con.conkey, con.conname
   FROM pg_constraint con WHERE con.contype='f' AND con.confrelid='public.customers'::regclass
 LOOP
   IF cardinality(v_fk.conkey)<>1 THEN
     RAISE EXCEPTION 'Deletion blocked by complex linked records (%)', v_fk.conname; END IF;
   SELECT attname INTO v_column FROM pg_attribute
   WHERE attrelid=v_fk.conrelid AND attnum=v_fk.conkey[1];
   EXECUTE format('SELECT EXISTS (SELECT 1 FROM %s WHERE %I=$1)',v_fk.conrelid::regclass,v_column)
     INTO v_found USING p_customer;
   IF v_found THEN
     RAISE EXCEPTION 'Cannot delete customer: linked business records exist in %',v_fk.conrelid::regclass;
   END IF;
 END LOOP;
 DELETE FROM public.customers WHERE id=p_customer AND approval_status='rejected';
 INSERT INTO public.rejected_customer_deletion_log(customer_id,owner_auth_user_id,deleted_by)
 VALUES(p_customer,v_owner,auth.uid());
 RETURN v_owner;
END; $$;
REVOKE ALL ON FUNCTION public.admin_delete_rejected_customer(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.admin_delete_rejected_customer(uuid) TO authenticated;

-- A failed Auth cleanup can be retried with the original customer id.
CREATE OR REPLACE FUNCTION public.admin_get_pending_rejected_auth_cleanup(p_customer uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_owner uuid; BEGIN
 IF auth.uid() IS NULL OR public.get_user_role()<>'admin' THEN
  RAISE EXCEPTION 'Administrator permission required' USING ERRCODE='42501'; END IF;
 SELECT owner_auth_user_id INTO v_owner FROM public.rejected_customer_deletion_log
 WHERE customer_id=p_customer AND auth_deleted_at IS NULL ORDER BY deleted_at DESC LIMIT 1;
 RETURN v_owner;
END; $$;
REVOKE ALL ON FUNCTION public.admin_get_pending_rejected_auth_cleanup(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.admin_get_pending_rejected_auth_cleanup(uuid) TO authenticated;

