-- FactoryFlow: Customer self-service portal
-- Adds: customer accounts (self-signup, linked to a company/customers row),
-- admin approval workflow, company-exclusive branded products, bundle sales
-- unit, self-service ordering with server-trusted pricing, and in-app
-- notifications (order confirmed / account approved).

-- ============ CUSTOMERS: link a portal login to a company, add approval ============

CREATE TYPE customer_approval_status AS ENUM ('pending', 'approved', 'rejected');

ALTER TABLE customers
  ADD COLUMN owner_profile_id UUID UNIQUE REFERENCES profiles(id) ON DELETE SET NULL,
  ADD COLUMN approval_status customer_approval_status NOT NULL DEFAULT 'approved';

COMMENT ON COLUMN customers.owner_profile_id IS
  'Set when this company was created via customer self-signup; NULL for companies added directly by staff.';
COMMENT ON COLUMN customers.approval_status IS
  'Self-signed-up companies start pending and must be approved by staff before their portal account can place orders. Staff-added customers default to approved.';

-- ============ FINISHED GOODS: company-exclusive branded products, list price, bundles ============

ALTER TABLE finished_goods
  ADD COLUMN customer_id UUID REFERENCES customers(id),
  ADD COLUMN unit_price NUMERIC(12, 2),
  ADD COLUMN bundle_size INTEGER CHECK (bundle_size IS NULL OR bundle_size > 0);

CREATE INDEX idx_finished_goods_customer ON finished_goods(customer_id);

COMMENT ON COLUMN finished_goods.customer_id IS
  'NULL = generally available to any customer (semi-finished rolls, packing bag bundles). Set = exclusive branded product only that company may order.';
COMMENT ON COLUMN finished_goods.unit_price IS
  'List price used for customer self-service ordering. Required for any product a customer should be able to order online; staff-created orders may still use a different negotiated unit_price.';
COMMENT ON COLUMN finished_goods.bundle_size IS
  'Number of individual pieces per bundle, informational, only relevant when unit = bundle.';

-- ============ AUTO-CREATE COMPANY + CUSTOMER PROFILE ON CUSTOMER SIGNUP ============
-- Extends the existing handle_new_user() trigger: when a new auth user signs up
-- with role = 'customer' in their metadata, also create their company (customers)
-- row from the signup form data, pending approval. This runs SECURITY DEFINER as
-- part of user creation, so it works even before the user confirms their email
-- (i.e. before they have an authenticated session), avoiding any RLS timing issues.

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
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============ NOTIFICATIONS ============

CREATE TABLE notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  order_id UUID REFERENCES orders(id) ON DELETE CASCADE,
  is_read BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_notifications_profile ON notifications(profile_id, is_read);

ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users read own notifications" ON notifications
  FOR SELECT USING (profile_id = auth.uid());

CREATE POLICY "Users update own notifications" ON notifications
  FOR UPDATE USING (profile_id = auth.uid())
  WITH CHECK (profile_id = auth.uid());

CREATE POLICY "Admin full access notifications" ON notifications
  FOR ALL USING (get_user_role() = 'admin');

-- Notify the customer's portal account when their order is confirmed.
CREATE OR REPLACE FUNCTION notify_customer_on_order_confirmed()
RETURNS TRIGGER AS $$
DECLARE
  v_owner_profile_id UUID;
BEGIN
  IF NEW.status = 'confirmed' AND (OLD.status IS NULL OR OLD.status != 'confirmed') THEN
    SELECT owner_profile_id INTO v_owner_profile_id FROM customers WHERE id = NEW.customer_id;

    IF v_owner_profile_id IS NOT NULL THEN
      INSERT INTO notifications (profile_id, type, title, message, order_id)
      VALUES (
        v_owner_profile_id,
        'order_confirmed',
        'Order Confirmed',
        'Your order ' || NEW.order_number || ' has been confirmed.',
        NEW.id
      );
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER trg_notify_customer_order_confirmed
  AFTER UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION notify_customer_on_order_confirmed();

-- Notify the customer's portal account when staff approve their company.
CREATE OR REPLACE FUNCTION notify_customer_on_approval()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.approval_status = 'approved'
     AND (OLD.approval_status IS NULL OR OLD.approval_status != 'approved')
     AND NEW.owner_profile_id IS NOT NULL THEN
    INSERT INTO notifications (profile_id, type, title, message)
    VALUES (
      NEW.owner_profile_id,
      'account_approved',
      'Account Approved',
      'Your company account has been approved. You can now place orders.'
    );
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER trg_notify_customer_approval
  AFTER UPDATE ON customers
  FOR EACH ROW EXECUTE FUNCTION notify_customer_on_approval();

-- ============ PRICE INTEGRITY: customer self-service orders always use the list price ============
-- Prevents a customer from setting their own unit_price on an order they place
-- themselves. Staff-created orders (any other role) are unaffected.

CREATE OR REPLACE FUNCTION enforce_order_item_price()
RETURNS TRIGGER AS $$
DECLARE
  v_price NUMERIC;
BEGIN
  IF get_user_role() = 'customer' THEN
    SELECT unit_price INTO v_price FROM finished_goods WHERE id = NEW.finished_good_id;

    IF v_price IS NULL THEN
      RAISE EXCEPTION 'This product is not available for online ordering yet. Please contact sales.';
    END IF;

    NEW.unit_price := v_price;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER trg_enforce_order_item_price
  BEFORE INSERT ON order_items
  FOR EACH ROW EXECUTE FUNCTION enforce_order_item_price();

-- ============ RLS: customer self-service access ============

-- Companies: a customer may only see their own company record.
CREATE POLICY "Customer read own company" ON customers
  FOR SELECT USING (owner_profile_id = auth.uid());

-- Finished goods: a customer may see generally-available products plus any
-- branded product exclusive to their own company.
CREATE POLICY "Customer read available finished goods" ON finished_goods
  FOR SELECT USING (
    get_user_role() = 'customer'
    AND (
      customer_id IS NULL
      OR customer_id = (SELECT id FROM customers WHERE owner_profile_id = auth.uid())
    )
  );

-- Orders: a customer may read and create orders only for their own (approved) company.
CREATE POLICY "Customer read own orders" ON orders
  FOR SELECT USING (
    customer_id = (SELECT id FROM customers WHERE owner_profile_id = auth.uid())
  );

CREATE POLICY "Customer insert own orders" ON orders
  FOR INSERT WITH CHECK (
    get_user_role() = 'customer'
    AND customer_id = (SELECT id FROM customers WHERE owner_profile_id = auth.uid())
    AND status = 'pending'
    AND EXISTS (
      SELECT 1 FROM customers
      WHERE id = customer_id AND approval_status = 'approved'
    )
  );

-- Order items: a customer may read/create items only on their own orders, and
-- only for products they're allowed to buy (generic or their own branded line).
CREATE POLICY "Customer read own order items" ON order_items
  FOR SELECT USING (
    order_id IN (
      SELECT id FROM orders
      WHERE customer_id = (SELECT id FROM customers WHERE owner_profile_id = auth.uid())
    )
  );

CREATE POLICY "Customer insert own order items" ON order_items
  FOR INSERT WITH CHECK (
    get_user_role() = 'customer'
    AND order_id IN (
      SELECT id FROM orders
      WHERE customer_id = (SELECT id FROM customers WHERE owner_profile_id = auth.uid())
    )
    AND finished_good_id IN (
      SELECT id FROM finished_goods
      WHERE customer_id IS NULL
         OR customer_id = (SELECT id FROM customers WHERE owner_profile_id = auth.uid())
    )
  );
