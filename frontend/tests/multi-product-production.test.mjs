import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const repo = join(dirname(fileURLToPath(import.meta.url)), '../..')
const source = (file) => readFileSync(join(repo, file), 'utf8')
const sql = source('supabase/migrations/20261115000025_multi_product_production.sql')
const ui = source('frontend/src/pages/production/ProductionRunForm.tsx')
const history = source('frontend/src/pages/production/ProductionPage.tsx')

test('multi-product posting is supervisor-only and reuses one atomic input deduction', () => {
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.post_multi_production_run\(/)
  assert.match(sql, /get_user_role\(\) NOT IN \('admin','production_supervisor'\)/)
  assert.match(sql, /v_run:=public\.post_production_run\(p_run,p_materials\)/)
  assert.equal((sql.match(/v_run:=public\.post_production_run\(/g) || []).length, 1)
  assert.match(sql, /INSERT INTO public\.production_run_additional_outputs\(/)
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.post_multi_production_run.*TO authenticated/)
})

test('additional outputs cannot be posted directly and credit each stock line and physical roll', () => {
  assert.match(sql, /REVOKE ALL ON TABLE public\.production_run_additional_outputs FROM PUBLIC, anon, authenticated/)
  assert.match(sql, /CREATE TRIGGER trg_production_additional_immutable/)
  assert.match(sql, /current_stock=current_stock\+NEW\.output_quantity/)
  assert.match(sql, /INSERT INTO public\.product_rolls\(finished_good_id,production_run_id,production_output_id,weight_kg,micron\)/)
  assert.match(sql, /v_actual IS DISTINCT FROM v_expected/)
  assert.match(sql, /NEW\.output_quantity:=cardinality\(NEW\.roll_weights\)/)
})

test('UI supports multiple product lines with independent batches and measured roll weights', () => {
  assert.match(ui, /Additional Products/)
  assert.match(ui, /\+ Add Product/)
  assert.match(ui, /setAdditionalOutputs/)
  assert.match(ui, /post_multi_production_run/)
  assert.match(ui, /p_additional_outputs: moreOutputs/)
  assert.match(ui, /batch_id: line\.batch_id/)
  assert.match(ui, /roll_weights: product\.unit === 'rolls'/)
  assert.match(ui, /outputOptions = isConversion \? finishedOnlyGoods : semiFinishedGoods/)
})

test('production history, dashboard and roll search include secondary output records', () => {
  assert.match(history, /production_run_additional_outputs\(/)
  assert.match(sql, /CASE WHEN extra\.id IS NOT NULL THEN extra\.batch_id ELSE pr\.batch_id END/)
  assert.match(sql, /LEFT JOIN public\.production_run_additional_outputs extra ON extra\.id = r\.production_output_id/)
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.dashboard_metrics/)
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.dashboard_trends/)
  assert.match(sql, /extra\.production_run_id=pr\.id/)
})
