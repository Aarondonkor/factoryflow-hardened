-- FactoryFlow: make requested micron fully dynamic, per order — not configured
-- on the product at all.
--
-- Migration 011 added an optional spec_thickness_min/max range on finished_goods
-- so a customer's exclusive branded roll could be constrained to a staff-set
-- range. In practice a branded roll's requested thickness can change freely
-- from one order to the next (the same customer might want 45µ this week and
-- 32µ next week) with no advance notice, so pinning even a *range* to the
-- product record is the wrong shape: it implies the database needs updating
-- whenever a customer's needs shift outside whatever range was guessed at
-- product-creation time.
--
-- The product row now only carries stable identity/metadata (name, id,
-- customer, width, color, unit, price, bundle size). The requested micron
-- lives entirely on order_items.specified_micron, entered fresh on every
-- order, with only a generous sanity check (not a business constraint).

DROP TRIGGER IF EXISTS trg_enforce_order_item_micron_range ON order_items;
DROP FUNCTION IF EXISTS enforce_order_item_micron_range();

ALTER TABLE finished_goods
  DROP CONSTRAINT IF EXISTS finished_goods_thickness_range_valid,
  DROP COLUMN IF EXISTS spec_thickness_min,
  DROP COLUMN IF EXISTS spec_thickness_max;

-- Replace with a plain sanity check on the value itself — catches fat-finger
-- input (0, negative, or absurdly large) without encoding any per-product or
-- per-customer business rule into the schema.
ALTER TABLE order_items
  ADD CONSTRAINT order_items_specified_micron_sane CHECK (
    specified_micron IS NULL OR (specified_micron > 0 AND specified_micron <= 500)
  );

-- Still require SOME micron for roll-unit products (unchanged requirement —
-- just no longer checked against a product-level range).
CREATE OR REPLACE FUNCTION enforce_order_item_micron_required()
RETURNS TRIGGER AS $$
DECLARE
  v_unit output_unit;
BEGIN
  SELECT unit INTO v_unit FROM finished_goods WHERE id = NEW.finished_good_id;

  IF v_unit = 'rolls' AND NEW.specified_micron IS NULL THEN
    RAISE EXCEPTION 'A micron (thickness) must be specified for this roll product';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE TRIGGER trg_enforce_order_item_micron_required
  BEFORE INSERT ON order_items
  FOR EACH ROW EXECUTE FUNCTION enforce_order_item_micron_required();
