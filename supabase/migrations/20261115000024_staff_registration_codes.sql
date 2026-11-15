-- FactoryFlow / Purifa Ventures: single-use employee registration codes.
-- New migration ONLY; do not edit historical migrations already deployed.
-- Every code is issued by an authenticated administrator, bound to one email
-- address and one non-admin role, and redeemed atomically during Auth signup.
-- No SMTP invitation or service-role key is required in the browser.

CREATE TABLE public.staff_registration_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code_hash text NOT NULL UNIQUE,
  employee_name text NOT NULL CHECK (char_length(btrim(employee_name)) BETWEEN 2 AND 120),
  employee_email text NOT NULL CHECK (char_length(btrim(employee_email)) BETWEEN 3 AND 254),
  staff_role public.user_role NOT NULL
    CHECK (staff_role IN ('staff','production_supervisor','sales_staff','hr_officer')),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  redeemed_user_id uuid UNIQUE,
  redeemed_at timestamptz,
  revoked_at timestamptz,
  CONSTRAINT staff_registration_code_use_pair CHECK
    ((redeemed_user_id IS NULL) = (redeemed_at IS NULL)),
  CONSTRAINT staff_registration_code_expiry CHECK (expires_at > created_at)
);
CREATE INDEX staff_registration_codes_recent_idx
  ON public.staff_registration_codes (created_at DESC);

-- Even authenticated clients cannot read hashes or modify code records.
ALTER TABLE public.staff_registration_codes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.staff_registration_codes FROM PUBLIC, anon, authenticated;

-- Generate an unguessable 122-bit UUID-derived code and return it ONCE.
-- Only its SHA-256 hash is persisted. A single code is for a named employee
-- with an exact email address (no emails are sent by this action).
CREATE OR REPLACE FUNCTION public.admin_create_staff_registration_code(
  p_employee_name text,
  p_employee_email text,
  p_role public.user_role,
  p_valid_hours integer DEFAULT 72
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_code text;
  v_uuid text;
  v_id uuid;
  v_expires timestamptz;
  v_name text := btrim(coalesce(p_employee_name,''));
  v_email text := lower(btrim(coalesce(p_employee_email,'')));
BEGIN
  IF auth.uid() IS NULL OR public.get_user_role() IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'Administrator required' USING ERRCODE = '42501';
  END IF;
  IF p_role IS NULL OR p_role NOT IN ('staff','production_supervisor','sales_staff','hr_officer') THEN
    RAISE EXCEPTION 'Invalid employee role' USING ERRCODE = '22023';
  END IF;
  IF char_length(v_name) NOT BETWEEN 2 AND 120 THEN
    RAISE EXCEPTION 'Employee name must be 2–120 characters' USING ERRCODE = '22023';
  END IF;
  IF char_length(v_email) > 254 OR
     v_email !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$' THEN
    RAISE EXCEPTION 'Valid employee email required' USING ERRCODE = '22023';
  END IF;
  IF p_valid_hours IS NULL OR p_valid_hours NOT BETWEEN 1 AND 168 THEN
    RAISE EXCEPTION 'Code lifetime must be 1–168 hours' USING ERRCODE = '22023';
  END IF;

  v_uuid := upper(replace(gen_random_uuid()::text, '-', ''));
  v_code := 'PV-' || substr(v_uuid,1,8) || '-' || substr(v_uuid,9,8)
                  || '-' || substr(v_uuid,17,8) || '-' || substr(v_uuid,25,8);
  v_expires := now() + make_interval(hours => p_valid_hours);
  INSERT INTO public.staff_registration_codes
    (code_hash, employee_name, employee_email, staff_role, created_by, expires_at)
  VALUES
    (encode(sha256(convert_to(v_code, 'UTF8')), 'hex'),
     v_name, v_email, p_role, auth.uid(), v_expires)
  RETURNING id INTO v_id;

  RETURN jsonb_build_object(
    'id', v_id,
    'code', v_code,
    'employee_name', v_name,
    'employee_email', v_email,
    'staff_role', p_role::text,
    'expires_at', v_expires
  );
END; $$;
REVOKE ALL ON FUNCTION public.admin_create_staff_registration_code(text,text,public.user_role,integer)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_create_staff_registration_code(text,text,public.user_role,integer)
  TO authenticated;

-- Return admin-visible metadata; never return code_hash or plaintext code.
CREATE OR REPLACE FUNCTION public.admin_list_staff_registration_codes()
RETURNS TABLE (
  id uuid,
  employee_name text,
  employee_email text,
  staff_role public.user_role,
  created_at timestamptz,
  expires_at timestamptz,
  redeemed_at timestamptz,
  revoked_at timestamptz
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF auth.uid() IS NULL OR public.get_user_role() IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'Administrator required' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    SELECT c.id, c.employee_name, c.employee_email, c.staff_role,
           c.created_at, c.expires_at, c.redeemed_at, c.revoked_at
    FROM public.staff_registration_codes AS c
    ORDER BY c.created_at DESC
    LIMIT 100;
END; $$;
REVOKE ALL ON FUNCTION public.admin_list_staff_registration_codes() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_list_staff_registration_codes() TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_revoke_staff_registration_code(p_code_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF auth.uid() IS NULL OR public.get_user_role() IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'Administrator required' USING ERRCODE = '42501';
  END IF;
  UPDATE public.staff_registration_codes
  SET revoked_at = now()
  WHERE id = p_code_id AND redeemed_at IS NULL AND revoked_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Code not found or no longer active' USING ERRCODE = '22023';
  END IF;
END; $$;
REVOKE ALL ON FUNCTION public.admin_revoke_staff_registration_code(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_revoke_staff_registration_code(uuid) TO authenticated;

-- BEFORE INSERT: redeem the code in the *same transaction* as auth.users.
-- A failed or rolled-back signup does not consume a code.
-- An already-used, expired, revoked, email-mismatched, or invalid code rejects
-- the registration. Remove the submitted code from user metadata so it does not
-- become a stored credential in auth.users.
CREATE OR REPLACE FUNCTION public.validate_staff_registration_on_signup()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_code text;
  v_used_id uuid;
BEGIN
  v_code := upper(btrim(coalesce(NEW.raw_user_meta_data->>'employee_registration_code','')));
  IF v_code = '' THEN
    RETURN NEW; -- ordinary customer signup
  END IF;
  IF v_code !~ '^PV-[0-9A-F]{8}(-[0-9A-F]{8}){3}$' THEN
    RAISE EXCEPTION 'Invalid employee registration code' USING ERRCODE = '22023';
  END IF;
  UPDATE public.staff_registration_codes
     SET redeemed_user_id = NEW.id, redeemed_at = now()
   WHERE code_hash = encode(sha256(convert_to(v_code,'UTF8')),'hex')
     AND redeemed_user_id IS NULL
     AND revoked_at IS NULL
     AND expires_at > now()
     AND employee_email = lower(btrim(NEW.email))
   RETURNING id INTO v_used_id;
  IF v_used_id IS NULL THEN
    RAISE EXCEPTION 'Invalid, expired, used, or email-mismatched employee code'
      USING ERRCODE = '22023';
  END IF;
  NEW.raw_user_meta_data := coalesce(NEW.raw_user_meta_data,'{}'::jsonb)
                             - 'employee_registration_code' - 'role';
  RETURN NEW;
END; $$;
REVOKE ALL ON FUNCTION public.validate_staff_registration_on_signup() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS before_auth_user_staff_code ON auth.users;
CREATE TRIGGER before_auth_user_staff_code
BEFORE INSERT ON auth.users
FOR EACH ROW EXECUTE FUNCTION public.validate_staff_registration_on_signup();

-- AFTER INSERT: role comes ONLY from the successfully redeemed database code.
-- Never trust client-provided role, employee name or other privilege claims.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_name text;
  v_role public.user_role;
BEGIN
  SELECT c.employee_name, c.staff_role INTO v_name, v_role
  FROM public.staff_registration_codes AS c
  WHERE c.redeemed_user_id = NEW.id;
  IF v_role IS NOT NULL THEN
    INSERT INTO public.profiles(id,email,full_name,role)
    VALUES (NEW.id, NEW.email, v_name, v_role);
    INSERT INTO public.employees(profile_id,full_name,role_title,contact_email,hire_date)
    VALUES (NEW.id, v_name, initcap(replace(v_role::text,'_',' ')), NEW.email, CURRENT_DATE);
  ELSE
    v_name := coalesce(nullif(btrim(NEW.raw_user_meta_data->>'full_name'),''), NEW.email);
    INSERT INTO public.profiles(id,email,full_name,role)
    VALUES (NEW.id, NEW.email, v_name, 'customer');
    INSERT INTO public.customers
      (owner_profile_id,name,business_name,contact_phone,contact_email,address,approval_status)
    VALUES (NEW.id, v_name, NEW.raw_user_meta_data->>'business_name',
      NEW.raw_user_meta_data->>'contact_phone',NEW.email,
      NEW.raw_user_meta_data->>'address','pending');
  END IF;
  RETURN NEW;
END; $$;
REVOKE ALL ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;

-- Decommission the former invitation finalizer; the new signup code is the
-- sole path for creating employees from public registration.
DROP FUNCTION IF EXISTS public.finalize_staff_invitation(uuid, public.user_role, text);
