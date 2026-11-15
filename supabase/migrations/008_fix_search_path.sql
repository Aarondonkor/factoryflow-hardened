-- FactoryFlow: fix search_path on SECURITY DEFINER functions from the customer portal.
-- This project previously hit a bug where handle_new_user() failed silently because
-- its search_path wasn't pinned. Migration 007's CREATE OR REPLACE of that function
-- (and the new trigger functions alongside it) needs the same fix explicitly, since
-- CREATE OR REPLACE does not carry over any search_path fix that was applied directly
-- against the live database outside of a migration file.

ALTER FUNCTION handle_new_user() SET search_path = public;
ALTER FUNCTION notify_customer_on_order_confirmed() SET search_path = public;
ALTER FUNCTION notify_customer_on_approval() SET search_path = public;
ALTER FUNCTION enforce_order_item_price() SET search_path = public;
