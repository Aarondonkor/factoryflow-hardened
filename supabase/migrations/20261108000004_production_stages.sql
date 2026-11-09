-- FactoryFlow: Two-stage production (semi-finished -> finished)
-- Extrusion machines produce semi-finished rolls (raw resin/additive -> semi-finished output).
-- Conversion machines (printing/cutting/sealing) turn semi-finished rolls into finished goods.
-- Semi-finished items remain sellable in their own right, so they live in `finished_goods`
-- tagged with a stage rather than a separate table.

-- ============ ENUMS ============

CREATE TYPE product_stage AS ENUM ('semi_finished', 'finished');
CREATE TYPE machine_stage AS ENUM ('extrusion', 'conversion');

-- ============ SCHEMA CHANGES ============

ALTER TABLE finished_goods
  ADD COLUMN stage product_stage NOT NULL DEFAULT 'finished';

ALTER TABLE machines
  ADD COLUMN stage machine_stage NOT NULL DEFAULT 'extrusion';

ALTER TABLE production_runs
  ADD COLUMN input_product_id UUID REFERENCES finished_goods(id),
  ADD COLUMN input_quantity_consumed NUMERIC(12, 2) NOT NULL DEFAULT 0;

CREATE INDEX idx_finished_goods_stage ON finished_goods(stage);
CREATE INDEX idx_production_runs_input_product ON production_runs(input_product_id);

COMMENT ON COLUMN finished_goods.stage IS
  'semi_finished = unbranded/unsealed roll output from extrusion; finished = branded/cut/sealed sellable product';
COMMENT ON COLUMN machines.stage IS
  'extrusion = raw materials -> semi-finished output; conversion = semi-finished input -> finished output';
COMMENT ON COLUMN production_runs.input_product_id IS
  'Semi-finished finished_goods row consumed by a conversion-stage run. NULL for extrusion-stage runs.';

-- ============ TRIGGER: replace inventory processing to branch on machine stage ============

CREATE OR REPLACE FUNCTION process_production_run_inventory()
RETURNS TRIGGER AS $$
DECLARE
  v_machine_stage machine_stage;
  v_resin_stock NUMERIC;
  v_additive_stock NUMERIC;
  v_input_stock NUMERIC;
BEGIN
  SELECT stage INTO v_machine_stage FROM machines WHERE id = NEW.machine_id;

  IF v_machine_stage IS NULL THEN
    RAISE EXCEPTION 'Machine not found';
  END IF;

  IF v_machine_stage = 'conversion' THEN
    -- Conversion runs consume a semi-finished input only; raw materials are not applicable.
    IF NEW.resin_material_id IS NOT NULL OR NEW.additive_material_id IS NOT NULL THEN
      RAISE EXCEPTION 'Conversion-stage runs cannot consume raw materials directly; they consume a semi-finished input product';
    END IF;

    IF NEW.input_product_id IS NULL OR NEW.input_quantity_consumed <= 0 THEN
      RAISE EXCEPTION 'Conversion-stage runs require an input_product_id and input_quantity_consumed > 0';
    END IF;

    SELECT current_stock INTO v_input_stock
    FROM finished_goods WHERE id = NEW.input_product_id FOR UPDATE;

    IF v_input_stock IS NULL THEN
      RAISE EXCEPTION 'Input product not found';
    END IF;
    IF v_input_stock < NEW.input_quantity_consumed THEN
      RAISE EXCEPTION 'Insufficient semi-finished stock. Available: %, Required: %', v_input_stock, NEW.input_quantity_consumed;
    END IF;

    UPDATE finished_goods
    SET current_stock = current_stock - NEW.input_quantity_consumed
    WHERE id = NEW.input_product_id;

    PERFORM record_stock_movement(
      'finished', NEW.input_product_id, 'out', NEW.input_quantity_consumed,
      'production_run', NEW.id, 'Semi-finished input consumed in conversion run'
    );

  ELSE
    -- Extrusion runs: unchanged behavior, deduct resin/additive raw materials.
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
  END IF;

  -- Add output (semi-finished or finished, whichever finished_good_id points to) — unchanged.
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

-- Trigger definition itself (AFTER INSERT on production_runs) is unchanged and already
-- points at process_production_run_inventory(), so no need to re-create it.

-- ============ SEED DATA: reflect the two real product lines ============
-- Adjust machine codes/names/specs to match your actual factory floor before relying on this.

INSERT INTO machines (machine_code, name, stage) VALUES
  ('CV-01', 'Cutting & Sealing Line 1', 'conversion');

INSERT INTO finished_goods (product_name, unit, current_stock, warehouse_location, stage) VALUES
  ('SLF Unbranded Roll (raw)', 'rolls', 0, 'Warehouse A - Semi-Finished', 'semi_finished'),
  ('Packing Bag Unsealed Roll (raw)', 'rolls', 0, 'Warehouse A - Semi-Finished', 'semi_finished'),
  ('SLF Branded Roll', 'rolls', 0, 'Warehouse B - Finished', 'finished'),
  ('Packing Bag Cut & Sealed', 'rolls', 0, 'Warehouse B - Finished', 'finished');

