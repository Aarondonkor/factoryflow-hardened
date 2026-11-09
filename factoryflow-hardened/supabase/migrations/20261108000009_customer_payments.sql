-- FactoryFlow: customer self-service payments + per-product orderability control.

-- ============ PER-PRODUCT CONTROL OVER CUSTOMER ORDERABILITY ============
-- Lets staff exclude a specific generally-available product from the customer
-- portal (e.g. raw/unsealed packing bag rolls stay internal-only, while raw
-- SLF rolls remain customer-orderable) without needing a separate mechanism
-- from "no price set yet".

ALTER TABLE finished_goods
  ADD COLUMN customer_orderable BOOLEAN NOT NULL DEFAULT true;

COMMENT ON COLUMN finished_goods.customer_orderable IS
  'Staff-controlled toggle. Even a generally-available (customer_id IS NULL) product can be hidden from customer self-service ordering by setting this false.';

-- Best-effort: exclude the raw/unsealed packing bag roll seeded in migration 004
-- from customer ordering, per the original request. Staff can toggle this per
-- product from Inventory going forward if product names differ from the seed.
UPDATE finished_goods
SET customer_orderable = false
WHERE stage = 'semi_finished' AND product_name ILIKE '%packing bag%';

-- Re-create the customer-facing finished_goods policy to respect the new flag.
DROP POLICY IF EXISTS "Customer read available finished goods" ON finished_goods;
CREATE POLICY "Customer read available finished goods" ON finished_goods
  FOR SELECT USING (
    get_user_role() = 'customer'
    AND customer_orderable = true
    AND (
      customer_id IS NULL
      OR customer_id = (SELECT id FROM customers WHERE owner_profile_id = auth.uid())
    )
  );

-- Re-create the order_items insert check to also require the flag (defense in
-- depth — a customer bypassing the UI and calling the API directly shouldn't
-- be able to order an excluded product just because they know its id).
DROP POLICY IF EXISTS "Customer insert own order items" ON order_items;
CREATE POLICY "Customer insert own order items" ON order_items
  FOR INSERT WITH CHECK (
    get_user_role() = 'customer'
    AND order_id IN (
      SELECT id FROM orders
      WHERE customer_id = (SELECT id FROM customers WHERE owner_profile_id = auth.uid())
    )
    AND finished_good_id IN (
      SELECT id FROM finished_goods
      WHERE customer_orderable = true
        AND (
          customer_id IS NULL
          OR customer_id = (SELECT id FROM customers WHERE owner_profile_id = auth.uid())
        )
    )
  );

-- ============ CUSTOMER SELF-SERVICE PAYMENTS (Paystack) ============
-- Mirrors the app's existing Paystack flow used by staff (client-side inline
-- popup, then insert into payments) rather than introducing a new server
-- component, for consistency with how the rest of this app is built.

-- Prevent the same Paystack transaction from ever being recorded twice,
-- regardless of entry point (customer portal or staff-recorded).
ALTER TABLE payments
  ADD CONSTRAINT payments_paystack_reference_unique UNIQUE (paystack_reference);

CREATE POLICY "Customer read own payments" ON payments
  FOR SELECT USING (
    order_id IN (
      SELECT id FROM orders
      WHERE customer_id = (SELECT id FROM customers WHERE owner_profile_id = auth.uid())
    )
  );

CREATE POLICY "Customer insert own payments" ON payments
  FOR INSERT WITH CHECK (
    get_user_role() = 'customer'
    AND payment_method = 'paystack'
    AND paystack_reference IS NOT NULL
    AND order_id IN (
      SELECT id FROM orders
      WHERE customer_id = (SELECT id FROM customers WHERE owner_profile_id = auth.uid())
    )
    AND amount <= (SELECT balance_due FROM orders WHERE id = order_id)
  );

-- Notify the customer's portal account whenever a payment lands on their
-- order, whether it came from the portal or was recorded by staff.
CREATE OR REPLACE FUNCTION notify_customer_on_payment()
RETURNS TRIGGER AS $$
DECLARE
  v_owner_profile_id UUID;
  v_order_number TEXT;
BEGIN
  SELECT c.owner_profile_id, o.order_number INTO v_owner_profile_id, v_order_number
  FROM orders o
  JOIN customers c ON c.id = o.customer_id
  WHERE o.id = NEW.order_id;

  IF v_owner_profile_id IS NOT NULL THEN
    INSERT INTO notifications (profile_id, type, title, message, order_id)
    VALUES (
      v_owner_profile_id,
      'payment_received',
      'Payment Received',
      'We received a payment of GHS ' || NEW.amount || ' on order ' || v_order_number || '.',
      NEW.order_id
    );
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE TRIGGER trg_notify_customer_payment
  AFTER INSERT ON payments
  FOR EACH ROW EXECUTE FUNCTION notify_customer_on_payment();
