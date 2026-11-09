-- FactoryFlow: consistency pass — pin search_path on every SECURITY DEFINER
-- function that was missed by migration 008.
--
-- 008 only patched the 4 functions introduced alongside the customer portal
-- (007). It did not touch the original core functions from 001/002, or the
-- production-stage rewrites in 004/005 — all of which are SECURITY DEFINER
-- and were left with no search_path pinned. In practice most of these are
-- invoked as triggers on public-schema tables, where Postgres's default
-- search_path already resolves correctly, which is why they haven't
-- misbehaved yet. But get_user_role() specifically is called from inside
-- nearly every RLS policy in the app — it is the single most load-bearing
-- function here — and leaving it (or any of these) unpinned means a future
-- Supabase/Postgres default change, or a role-level search_path override,
-- could silently break authorization or stock/order processing app-wide,
-- the same way handle_new_user() silently broke before. Pinning all of them
-- now closes this whole class of risk rather than fixing it one bug at a time.

ALTER FUNCTION get_user_role() SET search_path = public;
ALTER FUNCTION record_stock_movement(TEXT, UUID, stock_movement_type, NUMERIC, stock_source, UUID, TEXT) SET search_path = public;
ALTER FUNCTION process_production_run_inventory() SET search_path = public;
ALTER FUNCTION process_order_confirmation() SET search_path = public;
ALTER FUNCTION recalculate_order_total() SET search_path = public;
ALTER FUNCTION process_payment() SET search_path = public;
ALTER FUNCTION adjust_stock(TEXT, UUID, NUMERIC, stock_movement_type, TEXT) SET search_path = public;
ALTER FUNCTION process_production_run_material_inventory() SET search_path = public;

-- Separate consistency gap found in the same pass: employees.profile_id has
-- no uniqueness guarantee, but migration 013's signup trigger assumes at
-- most one employees row per profile (its backfill query relies on this).
-- NULL is still allowed multiple times (staff without a login), so this only
-- prevents the case the trigger actually depends on.
ALTER TABLE employees
  ADD CONSTRAINT employees_profile_id_unique UNIQUE (profile_id);
