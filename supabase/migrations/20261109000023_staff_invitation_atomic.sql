-- Atomic staff activation used only by the trusted invitation Edge Function.
CREATE OR REPLACE FUNCTION public.finalize_staff_invitation(
  p_user uuid, p_role public.user_role, p_name text
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_profile public.profiles%ROWTYPE;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Service role required'; END IF;
  IF p_role NOT IN ('staff','production_supervisor','sales_staff','hr_officer') THEN
    RAISE EXCEPTION 'Invalid staff role';
  END IF;
  IF LENGTH(TRIM(COALESCE(p_name,''))) < 2 THEN RAISE EXCEPTION 'Staff name required'; END IF;
  SELECT * INTO v_profile FROM public.profiles WHERE id=p_user FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Invited user profile not found'; END IF;
  IF v_profile.role <> 'customer' THEN RAISE EXCEPTION 'User is not a new invitee'; END IF;
  IF EXISTS (
    SELECT 1 FROM public.orders o JOIN public.customers c ON c.id=o.customer_id
    WHERE c.owner_profile_id=p_user
  ) THEN RAISE EXCEPTION 'Cannot reassign an existing customer who has orders'; END IF;

  UPDATE public.profiles SET role=p_role, full_name=TRIM(p_name) WHERE id=p_user;
  INSERT INTO public.employees(profile_id, full_name, role_title, contact_email, hire_date)
  VALUES(p_user,TRIM(p_name),INITCAP(REPLACE(p_role::text,'_',' ')),v_profile.email,CURRENT_DATE)
  ON CONFLICT (profile_id) DO UPDATE SET
    full_name=EXCLUDED.full_name,
    role_title=EXCLUDED.role_title,
    contact_email=EXCLUDED.contact_email;
  DELETE FROM public.customers
  WHERE owner_profile_id=p_user
    AND NOT EXISTS(SELECT 1 FROM public.orders WHERE customer_id=public.customers.id);
END; $$;
REVOKE ALL ON FUNCTION public.finalize_staff_invitation(uuid,public.user_role,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_staff_invitation(uuid,public.user_role,text) TO service_role;
