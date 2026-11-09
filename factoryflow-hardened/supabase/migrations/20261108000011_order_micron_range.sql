-- FactoryFlow: per-product allowed micron (thickness) range for roll orders.
-- A customer's exclusive branded roll is one catalog product, but the exact
-- thickness is chosen per order within a staff-configured range (e.g. a
-- customer's branded roll might be orderable anywhere from 30 to 45 microns).
-- When a product doesn't define a range, any positive micron value is still
-- accepted (unchanged behavior for generic roll products).

ALTER TABLE finished_goods
  ADD COLUMN spec_thickness_min NUMERIC(6, 2),
  ADD COLUMN spec_thickness_max NUMERIC(6, 2),
  ADD CONSTRAINT finished_goods_thickness_range_valid CHECK (
    spec_thickness_min IS NULL OR spec_thickness_max IS NULL OR spec_thickness_min <= spec_thickness_max
  );

COMMENT ON COLUMN finished_goods.spec_thickness_min IS
  'Lowest micron a customer may request for this product at order time. NULL = no range restriction (single fixed spec_thickness, or unrestricted).';
COMMENT ON COLUMN finished_goods.spec_thickness_max IS
  'Highest micron a customer may request for this product at order time.';

-- Enforce the range server-side (applies to any inserter — customer portal or
-- staff order form — not just the UI, since the UI bound alone can be bypassed).
CREATE OR REPLACE FUNCTION enforce_order_item_micron_range()
RETURNS TRIGGER AS $$
DECLARE
  v_min NUMERIC;
  v_max NUMERIC;
  v_unit output_unit;
BEGIN
  SELECT unit, spec_thickness_min, spec_thickness_max INTO v_unit, v_min, v_max
  FROM finished_goods WHERE id = NEW.finished_good_id;

  IF v_unit = 'rolls' AND NEW.specified_micron IS NULL THEN
    RAISE EXCEPTION 'A micron (thickness) must be specified for this roll product';
  END IF;

  IF NEW.specified_micron IS NOT NULL THEN
    IF v_min IS NOT NULL AND NEW.specified_micron < v_min THEN
      RAISE EXCEPTION 'Requested micron (%) is below this product''s allowed minimum of %', NEW.specified_micron, v_min;
    END IF;
    IF v_max IS NOT NULL AND NEW.specified_micron > v_max THEN
      RAISE EXCEPTION 'Requested micron (%) is above this product''s allowed maximum of %', NEW.specified_micron, v_max;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE TRIGGER trg_enforce_order_item_micron_range
  BEFORE INSERT ON order_items
  FOR EACH ROW EXECUTE FUNCTION enforce_order_item_micron_range();
