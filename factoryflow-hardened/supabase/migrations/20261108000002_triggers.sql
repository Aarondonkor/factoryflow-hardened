-- FactoryFlow: Inventory Automation Triggers

-- Record stock movement helper
CREATE OR REPLACE FUNCTION record_stock_movement(
  p_material_type TEXT,
  p_material_id UUID,
  p_movement_type stock_movement_type,
  p_quantity NUMERIC,
  p_source stock_source,
  p_source_id UUID DEFAULT NULL,
  p_reason TEXT DEFAULT NULL
)
RETURNS UUID AS $$
DECLARE
  v_movement_id UUID;
BEGIN
  INSERT INTO stock_movements (
    material_type, material_id, movement_type, quantity,
    source, source_id, reason, created_by
  ) VALUES (
    p_material_type, p_material_id, p_movement_type, p_quantity,
    p_source, p_source_id, p_reason, auth.uid()
  ) RETURNING id INTO v_movement_id;
  RETURN v_movement_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Production run: deduct raw materials, add finished goods
CREATE OR REPLACE FUNCTION process_production_run_inventory()
RETURNS TRIGGER AS $$
DECLARE
  v_resin_stock NUMERIC;
  v_additive_stock NUMERIC;
BEGIN
  -- Deduct resin
  IF NEW.resin_material_id IS NOT NULL AND NEW.resin_consumed > 0 THEN
    SELECT current_stock INTO v_resin_stock
    FROM raw_materials WHERE id = NEW.resin_material_id FOR UPDATE;

    IF v_resin_stock IS NULL THEN
      RAISE EXCEPTION 'Resin material not found';
    END IF;
    IF v_resin_stock < NEW.resin_consumed THEN
      RAISE EXCEPTION 'Insufficient resin stock. Available: % kg, Required: % kg', v_resin_stock, NEW.resin_consumed;
    END IF;

    UPDATE raw_materials
    SET current_stock = current_stock - NEW.resin_consumed
    WHERE id = NEW.resin_material_id;

    PERFORM record_stock_movement(
      'raw', NEW.resin_material_id, 'out', NEW.resin_consumed,
      'production_run', NEW.id, 'Resin consumed in production run'
    );
  END IF;

  -- Deduct additive
  IF NEW.additive_material_id IS NOT NULL AND NEW.additive_consumed > 0 THEN
    SELECT current_stock INTO v_additive_stock
    FROM raw_materials WHERE id = NEW.additive_material_id FOR UPDATE;

    IF v_additive_stock IS NULL THEN
      RAISE EXCEPTION 'Additive material not found';
    END IF;
    IF v_additive_stock < NEW.additive_consumed THEN
      RAISE EXCEPTION 'Insufficient additive stock. Available: % kg, Required: % kg', v_additive_stock, NEW.additive_consumed;
    END IF;

    UPDATE raw_materials
    SET current_stock = current_stock - NEW.additive_consumed
    WHERE id = NEW.additive_material_id;

    PERFORM record_stock_movement(
      'raw', NEW.additive_material_id, 'out', NEW.additive_consumed,
      'production_run', NEW.id, 'Additive consumed in production run'
    );
  END IF;

  -- Add finished goods output
  IF NEW.finished_good_id IS NOT NULL AND NEW.output_quantity > 0 THEN
    UPDATE finished_goods
    SET current_stock = current_stock + NEW.output_quantity
    WHERE id = NEW.finished_good_id;

    PERFORM record_stock_movement(
      'finished', NEW.finished_good_id, 'in', NEW.output_quantity,
      'production_run', NEW.id, 'Production output'
    );
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER trg_production_run_inventory
  AFTER INSERT ON production_runs
  FOR EACH ROW EXECUTE FUNCTION process_production_run_inventory();

-- Order confirmation: deduct finished goods
CREATE OR REPLACE FUNCTION process_order_confirmation()
RETURNS TRIGGER AS $$
DECLARE
  v_item RECORD;
  v_stock NUMERIC;
BEGIN
  IF NEW.status = 'confirmed' AND (OLD.status IS NULL OR OLD.status != 'confirmed') THEN
    NEW.confirmed_at = NOW();

    FOR v_item IN
      SELECT oi.finished_good_id, oi.quantity, fg.product_name, fg.current_stock
      FROM order_items oi
      JOIN finished_goods fg ON fg.id = oi.finished_good_id
      WHERE oi.order_id = NEW.id
    LOOP
      SELECT current_stock INTO v_stock
      FROM finished_goods WHERE id = v_item.finished_good_id FOR UPDATE;

      IF v_stock < v_item.quantity THEN
        RAISE EXCEPTION 'Insufficient stock for %. Available: %, Required: %',
          v_item.product_name, v_stock, v_item.quantity;
      END IF;

      UPDATE finished_goods
      SET current_stock = current_stock - v_item.quantity
      WHERE id = v_item.finished_good_id;

      PERFORM record_stock_movement(
        'finished', v_item.finished_good_id, 'out', v_item.quantity,
        'sale', NEW.id, 'Order confirmed: ' || NEW.order_number
      );
    END LOOP;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER trg_order_confirmation
  BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION process_order_confirmation();

-- Recalculate order totals from items
CREATE OR REPLACE FUNCTION recalculate_order_total()
RETURNS TRIGGER AS $$
DECLARE
  v_subtotal NUMERIC;
BEGIN
  SELECT COALESCE(SUM(line_total), 0) INTO v_subtotal
  FROM order_items WHERE order_id = COALESCE(NEW.order_id, OLD.order_id);

  UPDATE orders SET subtotal = v_subtotal, total = v_subtotal
  WHERE id = COALESCE(NEW.order_id, OLD.order_id);

  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER trg_order_items_total
  AFTER INSERT OR UPDATE OR DELETE ON order_items
  FOR EACH ROW EXECUTE FUNCTION recalculate_order_total();

-- Payment: update order amount_paid
CREATE OR REPLACE FUNCTION process_payment()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE orders
  SET amount_paid = amount_paid + NEW.amount,
      status = CASE
        WHEN amount_paid + NEW.amount >= total THEN 'paid'::order_status
        ELSE status
      END
  WHERE id = NEW.order_id;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER trg_payment_recorded
  AFTER INSERT ON payments
  FOR EACH ROW EXECUTE FUNCTION process_payment();

-- Manual stock adjustment function
CREATE OR REPLACE FUNCTION adjust_stock(
  p_material_type TEXT,
  p_material_id UUID,
  p_quantity NUMERIC,
  p_movement_type stock_movement_type,
  p_reason TEXT
)
RETURNS VOID AS $$
DECLARE
  v_current NUMERIC;
BEGIN
  IF p_material_type = 'raw' THEN
    SELECT current_stock INTO v_current FROM raw_materials WHERE id = p_material_id FOR UPDATE;
    IF v_current IS NULL THEN RAISE EXCEPTION 'Raw material not found'; END IF;
    IF p_movement_type = 'out' AND v_current < p_quantity THEN
      RAISE EXCEPTION 'Insufficient stock';
    END IF;
    UPDATE raw_materials SET
      current_stock = CASE WHEN p_movement_type = 'in' THEN current_stock + p_quantity ELSE current_stock - p_quantity END,
      last_restock_date = CASE WHEN p_movement_type = 'in' AND p_reason ILIKE '%restock%' THEN CURRENT_DATE ELSE last_restock_date END
    WHERE id = p_material_id;
  ELSIF p_material_type = 'finished' THEN
    SELECT current_stock INTO v_current FROM finished_goods WHERE id = p_material_id FOR UPDATE;
    IF v_current IS NULL THEN RAISE EXCEPTION 'Finished good not found'; END IF;
    IF p_movement_type = 'out' AND v_current < p_quantity THEN
      RAISE EXCEPTION 'Insufficient stock';
    END IF;
    UPDATE finished_goods SET
      current_stock = CASE WHEN p_movement_type = 'in' THEN current_stock + p_quantity ELSE current_stock - p_quantity END
    WHERE id = p_material_id;
  ELSE
    RAISE EXCEPTION 'Invalid material type';
  END IF;

  PERFORM record_stock_movement(
    p_material_type, p_material_id, p_movement_type, p_quantity,
    CASE WHEN p_reason ILIKE '%restock%' THEN 'restock'::stock_source ELSE 'manual_adjustment'::stock_source END,
    NULL, p_reason
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Low stock view
CREATE OR REPLACE VIEW low_stock_materials AS
SELECT id, name, current_stock, reorder_threshold, unit,
  'raw' AS material_type
FROM raw_materials
WHERE current_stock <= reorder_threshold AND reorder_threshold > 0;
