-- FactoryFlow: customers choose the individual weight (kg) of each roll, per order.
--
-- Same shape as the micron decision (see 012): the product row stays stable
-- identity/metadata only, and the spec the customer wants THIS time lives on
-- the order line. A customer can order 25 kg rolls one week and 30 kg the next
-- against the same branded product with no database change in between.
--
-- NOTE: pricing is unchanged. order_items.unit_price is still per roll, so
-- line_total = quantity x unit_price regardless of the chosen weight. The
-- weight is a production/fulfilment spec, not (yet) a price input.

ALTER TABLE order_items
  ADD COLUMN specified_roll_weight NUMERIC(8, 2);

COMMENT ON COLUMN order_items.specified_roll_weight IS
  'Customer-requested weight in kg of EACH roll on this line (so total kg = quantity x this). Required for roll-unit products; NULL otherwise.';

-- Catch fat-finger input only; no per-product business rule.
ALTER TABLE order_items
  ADD CONSTRAINT order_items_specified_roll_weight_sane CHECK (
    specified_roll_weight IS NULL OR (specified_roll_weight > 0 AND specified_roll_weight <= 500)
  );

-- Roll-unit products must carry a weight, same as they must carry a micron.
-- Applies to every inserter (customer portal and staff order form). Rows that
-- already exist are untouched: this only fires on new inserts.
CREATE OR REPLACE FUNCTION enforce_order_item_roll_weight_required()
RETURNS TRIGGER AS $$
DECLARE
  v_unit output_unit;
BEGIN
  SELECT unit INTO v_unit FROM finished_goods WHERE id = NEW.finished_good_id;

  IF v_unit = 'rolls' AND NEW.specified_roll_weight IS NULL THEN
    RAISE EXCEPTION 'A roll weight (kg per roll) must be specified for this roll product';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE TRIGGER trg_enforce_order_item_roll_weight_required
  BEFORE INSERT ON order_items
  FOR EACH ROW EXECUTE FUNCTION enforce_order_item_roll_weight_required();
