-- FactoryFlow: individual roll inventory.
--
-- A printing run logs the weight of every roll it produced, e.g.
--   Ice Water: [12.3, 14.6, 20, 11, 19.9]
-- Each weight becomes one row in product_rolls. Customers see the individual
-- rolls that are available (with weights and the total), pick the ones they
-- want, and the cost is worked out from the picked weights.
--
-- PRICING for roll products: finished_goods.unit_price on a product counted
-- in rolls is the price PER KG. A roll line on an order is stored as
--   quantity = total kg of the picked rolls, unit_price = price per kg,
-- so the existing generated line_total (quantity x unit_price) is exactly
-- total kg x price per kg. Non-roll products are unchanged.

-- ============ 1. Undo 015 (customer-typed roll weight) ============
-- Customers no longer type a weight; they pick real rolls. Safe whether or
-- not 015 was ever applied.
DROP TRIGGER IF EXISTS trg_enforce_order_item_roll_weight_required ON order_items;
DROP FUNCTION IF EXISTS enforce_order_item_roll_weight_required();
ALTER TABLE order_items DROP CONSTRAINT IF EXISTS order_items_specified_roll_weight_sane;
ALTER TABLE order_items DROP COLUMN IF EXISTS specified_roll_weight;

-- ============ 2. Individual rolls ============

CREATE TYPE roll_status AS ENUM ('available', 'reserved', 'sold');

CREATE TABLE product_rolls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  roll_no BIGINT GENERATED ALWAYS AS IDENTITY,
  finished_good_id UUID NOT NULL REFERENCES finished_goods(id),
  production_run_id UUID REFERENCES production_runs(id) ON DELETE SET NULL,
  weight_kg NUMERIC(8, 2) NOT NULL CHECK (weight_kg > 0 AND weight_kg <= 500),
  micron NUMERIC(6, 2),
  status roll_status NOT NULL DEFAULT 'available',
  order_item_id UUID REFERENCES order_items(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_product_rolls_product_status ON product_rolls(finished_good_id, status);
CREATE INDEX idx_product_rolls_order_item ON product_rolls(order_item_id);

COMMENT ON TABLE product_rolls IS
  'One row per physical roll produced, with its own weight. available -> reserved (on a pending order) -> sold (order confirmed).';

-- Production runs can carry the list of roll weights.
ALTER TABLE production_runs
  ADD COLUMN roll_weights NUMERIC(8, 2)[];

COMMENT ON COLUMN production_runs.roll_weights IS
  'Weight in kg of each individual roll produced in this run. One product_rolls row is created per entry.';

-- Before the run is stored: validate the weights and make the run output
-- agree with them (output = number of rolls), so product stock and the
-- individual rolls can never disagree.
CREATE OR REPLACE FUNCTION normalize_run_for_rolls()
RETURNS TRIGGER AS $$
DECLARE
  v_unit output_unit;
BEGIN
  IF NEW.roll_weights IS NOT NULL AND cardinality(NEW.roll_weights) > 0 THEN
    IF NEW.finished_good_id IS NULL THEN
      RAISE EXCEPTION 'Select the output product before logging individual roll weights';
    END IF;

    SELECT unit INTO v_unit FROM finished_goods WHERE id = NEW.finished_good_id;
    IF v_unit IS DISTINCT FROM 'rolls' THEN
      RAISE EXCEPTION 'Individual roll weights can only be logged for products counted in rolls';
    END IF;

    IF EXISTS (SELECT 1 FROM unnest(NEW.roll_weights) AS w WHERE w IS NULL OR w <= 0 OR w > 500) THEN
      RAISE EXCEPTION 'Every roll weight must be greater than 0 and at most 500 kg';
    END IF;

    NEW.output_quantity := cardinality(NEW.roll_weights);
    NEW.output_unit := 'rolls';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE TRIGGER trg_normalize_run_for_rolls
  BEFORE INSERT ON production_runs
  FOR EACH ROW EXECUTE FUNCTION normalize_run_for_rolls();

-- After the run is stored: one roll row per logged weight (stock is credited
-- by the existing production-run trigger using output_quantity = roll count).
CREATE OR REPLACE FUNCTION create_rolls_from_run()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.roll_weights IS NOT NULL AND cardinality(NEW.roll_weights) > 0 THEN
    INSERT INTO product_rolls (finished_good_id, production_run_id, weight_kg, micron)
    SELECT NEW.finished_good_id, NEW.id, t.w, NEW.film_thickness
    FROM unnest(NEW.roll_weights) WITH ORDINALITY AS t(w, ord)
    ORDER BY t.ord;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE TRIGGER trg_create_rolls_from_run
  AFTER INSERT ON production_runs
  FOR EACH ROW EXECUTE FUNCTION create_rolls_from_run();

-- ============ 3. Row level security ============

ALTER TABLE product_rolls ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admin full access rolls" ON product_rolls
  FOR ALL USING (get_user_role() = 'admin');

CREATE POLICY "Production supervisor manage rolls" ON product_rolls
  FOR ALL USING (get_user_role() = 'production_supervisor')
  WITH CHECK (get_user_role() = 'production_supervisor');

CREATE POLICY "Staff read rolls" ON product_rolls
  FOR SELECT USING (get_user_role() IN ('sales_staff', 'hr_officer', 'staff'));

-- A customer sees (a) available rolls of products they may buy, and (b) the
-- rolls that are on their own orders. They never write to this table
-- directly; reservations go through place_customer_order() below.
CREATE POLICY "Customer read rolls" ON product_rolls
  FOR SELECT USING (
    get_user_role() = 'customer'
    AND (
      (
        status = 'available'
        AND finished_good_id IN (
          SELECT id FROM finished_goods
          WHERE customer_orderable
            AND (customer_id IS NULL
                 OR customer_id = (SELECT id FROM customers WHERE owner_profile_id = auth.uid()))
        )
      )
      OR order_item_id IN (
        SELECT oi.id FROM order_items oi
        JOIN orders o ON o.id = oi.order_id
        WHERE o.customer_id = (SELECT id FROM customers WHERE owner_profile_id = auth.uid())
      )
    )
  );

-- ============ 4. Orders: roll lines, stock and status ============

-- Customers may not add a roll-product line themselves (that would let them
-- name any quantity). Roll lines only come from place_customer_order(),
-- which flags the transaction. Staff are unaffected.
CREATE OR REPLACE FUNCTION enforce_roll_products_via_picker()
RETURNS TRIGGER AS $$
DECLARE
  v_unit output_unit;
BEGIN
  IF get_user_role() = 'customer'
     AND COALESCE(current_setting('app.roll_order', true), 'off') <> 'on' THEN
    SELECT unit INTO v_unit FROM finished_goods WHERE id = NEW.finished_good_id;
    IF v_unit = 'rolls' THEN
      RAISE EXCEPTION 'Roll products are ordered by selecting individual rolls';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE TRIGGER trg_enforce_roll_products_via_picker
  BEFORE INSERT ON order_items
  FOR EACH ROW EXECUTE FUNCTION enforce_roll_products_via_picker();

-- A roll line takes its micron from the rolls themselves, so the typed-micron
-- requirement is skipped for lines created by place_customer_order().
CREATE OR REPLACE FUNCTION enforce_order_item_micron_required()
RETURNS TRIGGER AS $$
DECLARE
  v_unit output_unit;
BEGIN
  IF COALESCE(current_setting('app.roll_order', true), 'off') = 'on' THEN
    RETURN NEW;
  END IF;

  SELECT unit INTO v_unit FROM finished_goods WHERE id = NEW.finished_good_id;

  IF v_unit = 'rolls' AND NEW.specified_micron IS NULL THEN
    RAISE EXCEPTION 'A micron (thickness) must be specified for this roll product';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Order confirmation deducts stock. For a roll line the stock unit is rolls,
-- so deduct the NUMBER OF ROLLS on the line, not its kg quantity. Everything
-- else in this function is unchanged from 002.
CREATE OR REPLACE FUNCTION process_order_confirmation()
RETURNS TRIGGER AS $$
DECLARE
  v_item RECORD;
  v_stock NUMERIC;
  v_qty NUMERIC;
BEGIN
  IF NEW.status = 'confirmed' AND (OLD.status IS NULL OR OLD.status != 'confirmed') THEN
    NEW.confirmed_at = NOW();

    FOR v_item IN
      SELECT oi.id AS item_id, oi.finished_good_id, oi.quantity, fg.product_name,
             (SELECT COUNT(*) FROM product_rolls pr WHERE pr.order_item_id = oi.id) AS roll_count
      FROM order_items oi
      JOIN finished_goods fg ON fg.id = oi.finished_good_id
      WHERE oi.order_id = NEW.id
    LOOP
      v_qty := CASE WHEN v_item.roll_count > 0 THEN v_item.roll_count ELSE v_item.quantity END;

      SELECT current_stock INTO v_stock
      FROM finished_goods WHERE id = v_item.finished_good_id FOR UPDATE;

      IF v_stock < v_qty THEN
        RAISE EXCEPTION 'Insufficient stock for %. Available: %, Required: %',
          v_item.product_name, v_stock, v_qty;
      END IF;

      UPDATE finished_goods
      SET current_stock = current_stock - v_qty
      WHERE id = v_item.finished_good_id;

      PERFORM record_stock_movement(
        'finished', v_item.finished_good_id, 'out', v_qty,
        'sale', NEW.id, 'Order confirmed: ' || NEW.order_number
      );
    END LOOP;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Keep roll status in step with the order: leaving 'pending' for any real
-- state sells the reserved rolls; cancelling a still-pending order frees them.
CREATE OR REPLACE FUNCTION sync_rolls_with_order_status()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.status = 'pending' AND NEW.status NOT IN ('pending', 'cancelled') THEN
    UPDATE product_rolls SET status = 'sold'
    WHERE status = 'reserved'
      AND order_item_id IN (SELECT id FROM order_items WHERE order_id = NEW.id);
  ELSIF OLD.status = 'pending' AND NEW.status = 'cancelled' THEN
    UPDATE product_rolls SET status = 'available', order_item_id = NULL
    WHERE status = 'reserved'
      AND order_item_id IN (SELECT id FROM order_items WHERE order_id = NEW.id);
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE TRIGGER trg_sync_rolls_with_order_status
  AFTER UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION sync_rolls_with_order_status();

-- If an order line is deleted, free any rolls still reserved against it.
CREATE OR REPLACE FUNCTION release_rolls_on_item_delete()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE product_rolls SET status = 'available', order_item_id = NULL
  WHERE order_item_id = OLD.id AND status = 'reserved';
  RETURN OLD;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE TRIGGER trg_release_rolls_on_item_delete
  BEFORE DELETE ON order_items
  FOR EACH ROW EXECUTE FUNCTION release_rolls_on_item_delete();

-- ============ 5. Placing an order with picked rolls (atomic) ============
-- p_items: JSON array of {"finished_good_id": "...", "quantity": 5} for
--          non-roll products (bundles, kg products).
-- p_roll_ids: the individual rolls the customer picked.
-- Everything happens in one transaction: either the order, its lines and the
-- roll reservations all exist, or none of them do. Rolls are locked while
-- checked, so two customers can never reserve the same roll.

CREATE OR REPLACE FUNCTION place_customer_order(
  p_delivery_date DATE,
  p_notes TEXT,
  p_items JSONB,
  p_roll_ids UUID[]
)
RETURNS UUID AS $$
DECLARE
  v_customer_id UUID;
  v_approval customer_approval_status;
  v_order_id UUID;
  v_item JSONB;
  v_fg_id UUID;
  v_qty NUMERIC;
  v_group RECORD;
  v_item_id UUID;
  v_roll_ids UUID[] := COALESCE(p_roll_ids, ARRAY[]::UUID[]);
  v_found INT;
  v_distinct INT;
BEGIN
  IF get_user_role() IS DISTINCT FROM 'customer' THEN
    RAISE EXCEPTION 'Only customer accounts can place orders here';
  END IF;

  SELECT id, approval_status INTO v_customer_id, v_approval
  FROM customers WHERE owner_profile_id = auth.uid();

  IF v_customer_id IS NULL OR v_approval != 'approved' THEN
    RAISE EXCEPTION 'Your company account has not been approved yet';
  END IF;

  IF COALESCE(jsonb_array_length(p_items), 0) = 0 AND cardinality(v_roll_ids) = 0 THEN
    RAISE EXCEPTION 'Add at least one product or roll to the order';
  END IF;

  INSERT INTO orders (customer_id, delivery_date, notes, status, created_by)
  VALUES (v_customer_id, p_delivery_date, p_notes, 'pending', auth.uid())
  RETURNING id INTO v_order_id;

  -- Non-roll lines (price is forced to the list price by the price trigger).
  FOR v_item IN SELECT * FROM jsonb_array_elements(COALESCE(p_items, '[]'::jsonb))
  LOOP
    v_fg_id := (v_item->>'finished_good_id')::UUID;
    v_qty := (v_item->>'quantity')::NUMERIC;

    IF v_qty IS NULL OR v_qty <= 0 THEN
      RAISE EXCEPTION 'Every product needs a quantity greater than 0';
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM finished_goods
      WHERE id = v_fg_id
        AND customer_orderable
        AND unit <> 'rolls'
        AND (customer_id IS NULL OR customer_id = v_customer_id)
    ) THEN
      RAISE EXCEPTION 'One of the products is not available for you to order';
    END IF;

    INSERT INTO order_items (order_id, finished_good_id, quantity)
    VALUES (v_order_id, v_fg_id, v_qty);
  END LOOP;

  -- Roll lines.
  IF cardinality(v_roll_ids) > 0 THEN
    SELECT COUNT(DISTINCT x) INTO v_distinct FROM unnest(v_roll_ids) AS x;

    -- Lock the picked rolls and make sure every one is still available and
    -- belongs to a product this customer may buy.
    SELECT COUNT(*) INTO v_found FROM (
      SELECT pr.id
      FROM product_rolls pr
      JOIN finished_goods fg ON fg.id = pr.finished_good_id
      WHERE pr.id = ANY(v_roll_ids)
        AND pr.status = 'available'
        AND fg.unit = 'rolls'
        AND fg.customer_orderable
        AND fg.unit_price IS NOT NULL
        AND (fg.customer_id IS NULL OR fg.customer_id = v_customer_id)
      FOR UPDATE OF pr
    ) locked;

    IF v_found <> v_distinct THEN
      RAISE EXCEPTION 'Some of the selected rolls are no longer available. Please refresh and pick again.';
    END IF;

    PERFORM set_config('app.roll_order', 'on', true);

    FOR v_group IN
      SELECT pr.finished_good_id,
             SUM(pr.weight_kg) AS total_kg,
             CASE WHEN COUNT(DISTINCT pr.micron) = 1 THEN MAX(pr.micron) ELSE NULL END AS micron,
             ARRAY_AGG(pr.id) AS ids
      FROM product_rolls pr
      WHERE pr.id = ANY(v_roll_ids)
      GROUP BY pr.finished_good_id
    LOOP
      INSERT INTO order_items (order_id, finished_good_id, quantity, specified_micron)
      VALUES (v_order_id, v_group.finished_good_id, v_group.total_kg, v_group.micron)
      RETURNING id INTO v_item_id;

      UPDATE product_rolls
      SET status = 'reserved', order_item_id = v_item_id
      WHERE id = ANY(v_group.ids);
    END LOOP;

    PERFORM set_config('app.roll_order', 'off', true);
  END IF;

  RETURN v_order_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION place_customer_order(DATE, TEXT, JSONB, UUID[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION place_customer_order(DATE, TEXT, JSONB, UUID[]) TO authenticated;

-- ============ 6. Payment only after the admin has confirmed the order ============
-- Matches the intended flow (customer orders -> admin confirms -> customer
-- pays) and stops a payment on a still-pending order from skipping
-- confirmation, which is what deducts stock.

DROP POLICY IF EXISTS "Customer insert own payments" ON payments;
CREATE POLICY "Customer insert own payments" ON payments
  FOR INSERT WITH CHECK (
    get_user_role() = 'customer'
    AND payment_method = 'paystack'
    AND paystack_reference IS NOT NULL
    AND order_id IN (
      SELECT id FROM orders
      WHERE customer_id = (SELECT id FROM customers WHERE owner_profile_id = auth.uid())
        AND status NOT IN ('pending', 'cancelled')
    )
    AND amount <= (SELECT balance_due FROM orders WHERE id = order_id)
  );
