-- FactoryFlow: employee signup was only creating a profiles row, never a
-- matching employees row — so new staff never showed up in HR (attendance,
-- payroll, etc). Mirrors the pattern already used for customer signup: the
-- employees row is created in the same SECURITY DEFINER trigger that creates
-- the profile, so it happens atomically regardless of email-confirmation
-- timing. search_path is pinned explicitly this time (see 008's note on why).

CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER AS $$
DECLARE
  v_role user_role;
BEGIN
  v_role := COALESCE((NEW.raw_user_meta_data->>'role')::user_role, 'staff');

  INSERT INTO public.profiles (id, email, full_name, role)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.email),
    v_role
  );

  IF v_role = 'customer' THEN
    INSERT INTO public.customers (
      owner_profile_id, name, business_name, contact_phone, contact_email, address, approval_status
    ) VALUES (
      NEW.id,
      COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.email),
      NEW.raw_user_meta_data->>'business_name',
      NEW.raw_user_meta_data->>'contact_phone',
      NEW.email,
      NEW.raw_user_meta_data->>'address',
      'pending'
    );
  ELSE
    INSERT INTO public.employees (
      profile_id, full_name, role_title, contact_phone, contact_email, hire_date
    ) VALUES (
      NEW.id,
      COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.email),
      COALESCE(NEW.raw_user_meta_data->>'role_title', INITCAP(REPLACE(v_role::text, '_', ' '))),
      NEW.raw_user_meta_data->>'contact_phone',
      NEW.email,
      CURRENT_DATE
    );
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Backfill: staff/admin accounts that signed up before this fix exist in
-- profiles but have no employees row. Create one for each, using today as a
-- placeholder hire_date since the real hire date isn't known — edit these in
-- HR afterward if you have the actual dates on file.
INSERT INTO public.employees (profile_id, full_name, role_title, contact_email, hire_date)
SELECT p.id, p.full_name, INITCAP(REPLACE(p.role::text, '_', ' ')), p.email, CURRENT_DATE
FROM public.profiles p
WHERE p.role != 'customer'
  AND NOT EXISTS (SELECT 1 FROM public.employees e WHERE e.profile_id = p.id);
