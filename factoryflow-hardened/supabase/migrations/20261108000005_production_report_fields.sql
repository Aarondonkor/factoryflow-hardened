-- FactoryFlow: Structured production report fields (matches the paper SLF Production Report)
-- Adds: multi-material formula per extrusion run, machine parameters (temps/speeds),
-- cutting vs. printing process fields, quality control, batch/grade on output.

-- ============ RAW MATERIALS: material code (paper form has "Material Code") ============

ALTER TABLE raw_materials
  ADD COLUMN material_code TEXT;

-- ============ PRODUCTION RUNS: report fields ============

CREATE TYPE conversion_process_type AS ENUM ('cutting', 'printing');

ALTER TABLE production_runs
  -- Who signed off, alongside the operator already captured
  ADD COLUMN supervisor_name TEXT,

  -- Which conversion process this run represents. Only meaningful when the run's
  -- machine is stage = 'conversion'; NULL for extrusion runs. Kept independent of the
  -- machine record itself (conversion stays one generic machine stage), so the same
  -- conversion machine could in principle be logged either way per run if needed.
  ADD COLUMN process_type conversion_process_type,

  -- Extrusion: formula + output detail
  ADD COLUMN formula_code TEXT,
  ADD COLUMN roll_count INTEGER,
  ADD COLUMN roll_length NUMERIC(10, 2),
  ADD COLUMN avg_weight_per_roll NUMERIC(10, 2),

  -- Production time
  ADD COLUMN start_time TIME,
  ADD COLUMN end_time TIME,
  ADD COLUMN total_runtime_hours NUMERIC(6, 2),
  ADD COLUMN downtime_hours NUMERIC(6, 2) NOT NULL DEFAULT 0,

  -- Extrusion machine parameters
  ADD COLUMN temp_z1 NUMERIC(5, 1),
  ADD COLUMN temp_z2 NUMERIC(5, 1),
  ADD COLUMN temp_z3 NUMERIC(5, 1),
  ADD COLUMN temp_z4 NUMERIC(5, 1),
  ADD COLUMN temp_z5 NUMERIC(5, 1),
  ADD COLUMN temp_z6 NUMERIC(5, 1),
  ADD COLUMN screw_speed_rpm NUMERIC(8, 2),
  ADD COLUMN line_speed_mpm NUMERIC(8, 2),

  -- Cutting machine parameters (process_type = 'cutting')
  ADD COLUMN cut_length_mm NUMERIC(8, 2),
  ADD COLUMN bottom_seal_offset_mm NUMERIC(8, 2),
  ADD COLUMN cutting_speed_cpm NUMERIC(8, 2),

  -- Printing machine parameters (process_type = 'printing')
  ADD COLUMN print_colours_count INTEGER,
  ADD COLUMN print_speed NUMERIC(8, 2),
  ADD COLUMN print_tension NUMERIC(8, 2),
  ADD COLUMN cleaned_rollers BOOLEAN,
  ADD COLUMN roll_edges_ok BOOLEAN,
  ADD COLUMN neatness_rating SMALLINT CHECK (neatness_rating BETWEEN 1 AND 5),

  -- Quality control (shared shape across extrusion/cutting/printing)
  ADD COLUMN samples_tested INTEGER,
  ADD COLUMN samples_passed INTEGER,
  ADD COLUMN samples_failed INTEGER,
  ADD COLUMN qc_issues TEXT[],
  ADD COLUMN qc_issue_other TEXT,

  -- Output batch identity (single output line per run, so these sit directly on the run)
  ADD COLUMN batch_id TEXT,
  ADD COLUMN quality_grade SMALLINT CHECK (quality_grade BETWEEN 1 AND 3);

COMMENT ON COLUMN production_runs.process_type IS
  'cutting = converts semi-finished roll into cut & sealed bags/sachets; printing = converts semi-finished roll into branded roll. NULL for extrusion runs.';

-- ============ MULTI-MATERIAL FORMULA (replaces rigid resin/additive fields for new runs) ============
-- resin_material_id/resin_consumed/additive_material_id/additive_consumed are kept on
-- production_runs for historical rows already recorded before this migration, but the
-- trigger below no longer processes them. New extrusion runs should record their formula
-- as one row per material here instead.

CREATE TABLE production_run_materials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  production_run_id UUID NOT NULL REFERENCES production_runs(id) ON DELETE CASCADE,
  raw_material_id UUID NOT NULL REFERENCES raw_materials(id),
  quantity_kg NUMERIC(12, 2) NOT NULL CHECK (quantity_kg > 0),
  proportion_pct NUMERIC(5, 2),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_production_run_materials_run ON production_run_materials(production_run_id);

ALTER TABLE production_run_materials ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admin full access run materials" ON production_run_materials
  FOR ALL USING (get_user_role() = 'admin');

CREATE POLICY "Production supervisor manage run materials" ON production_run_materials
  FOR ALL USING (get_user_role() = 'production_supervisor')
  WITH CHECK (get_user_role() = 'production_supervisor');

-- Deduct raw material stock as each formula line is recorded.
CREATE OR REPLACE FUNCTION process_production_run_material_inventory()
RETURNS TRIGGER AS $$
DECLARE
  v_stock NUMERIC;
BEGIN
  SELECT current_stock INTO v_stock
  FROM raw_materials WHERE id = NEW.raw_material_id FOR UPDATE;

  IF v_stock IS NULL THEN
    RAISE EXCEPTION 'Raw material not found';
  END IF;
  IF v_stock < NEW.quantity_kg THEN
    RAISE EXCEPTION 'Insufficient stock for material. Available: % kg, Required: % kg', v_stock, NEW.quantity_kg;
  END IF;

  UPDATE raw_materials
  SET current_stock = current_stock - NEW.quantity_kg
  WHERE id = NEW.raw_material_id;

  PERFORM record_stock_movement(
    'raw', NEW.raw_material_id, 'out', NEW.quantity_kg,
    'production_run', NEW.production_run_id, 'Material consumed per formula line'
  );

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER trg_production_run_material_inventory
  AFTER INSERT ON production_run_materials
  FOR EACH ROW EXECUTE FUNCTION process_production_run_material_inventory();

-- ============ TRIGGER: drop resin/additive handling from the run-level trigger ============
-- Extrusion runs no longer consume resin/additive directly on production_runs; that's now
-- handled per formula line above. Conversion-stage input deduction and output crediting
-- are unchanged from migration 004.

CREATE OR REPLACE FUNCTION process_production_run_inventory()
RETURNS TRIGGER AS $$
DECLARE
  v_machine_stage machine_stage;
  v_input_stock NUMERIC;
BEGIN
  SELECT stage INTO v_machine_stage FROM machines WHERE id = NEW.machine_id;

  IF v_machine_stage IS NULL THEN
    RAISE EXCEPTION 'Machine not found';
  END IF;

  IF v_machine_stage = 'conversion' THEN
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

-- Trigger definition itself (AFTER INSERT on production_runs) already points at
-- process_production_run_inventory(), so no need to re-create it.
