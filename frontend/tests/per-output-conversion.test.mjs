import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
const file = (p) => readFileSync(join(root, p), 'utf8')
const sql = file('supabase/migrations/20261117000027_per_output_conversion_inputs.sql')
const form = file('frontend/src/pages/production/ProductionRunForm.tsx')
const history = file('frontend/src/pages/production/ProductionPage.tsx')

test('per-output source contains one input product and consumed quantity per additional output', () => {
  assert.match(sql, /ADD COLUMN input_product_id UUID REFERENCES public\.finished_goods\(id\)/)
  assert.match(sql, /ADD COLUMN input_quantity_consumed NUMERIC/)
  assert.match(sql, /v_row\.input_product_id/)
  assert.match(sql, /input_product_id,input_quantity_consumed\)/)
  assert.match(form, /input_product_id: input!\.id/)
  assert.match(form, /input_quantity_consumed: input!\.unit === 'rolls'/)
})

test('each additional roll is consumed once, with its specific destination output recorded', () => {
  assert.match(sql, /ADD COLUMN consumed_in_output_id UUID REFERENCES public\.production_run_additional_outputs/)
  assert.match(sql, /status='available'\s+FOR UPDATE/)
  assert.match(sql, /COUNT\(DISTINCT roll_id\)/)
  assert.match(sql, /status='consumed', consumed_in_run_id=v_run, consumed_in_output_id=v_extra_id/)
  assert.match(sql, /v_updated<>v_nrolls/)
  assert.match(form, /selectedRollIdsAcrossOutputs\.size/)
  assert.match(form, /selectedRollIdsAcrossOutputs\.has\(roll\.id\)/)
  assert.match(form, /rollMicronMismatch\(roll\.micron, input\.id/)
})

test('conversion inputs are stage-checked and microns must match when specified', () => {
  assert.match(sql, /v_input_stage IS DISTINCT FROM 'semi_finished'/)
  assert.match(sql, /ABS\(v_input_micron-v_output_micron\)>0\.1/)
  assert.match(form, /micronMismatch\(line\.input_product_id, product\.id, line\.film_thickness\)/)
  assert.match(form, /Semi-finished input for output/)
})

test('one atomic multi-output RPC posts primary and each additional input with permission checks', () => {
  assert.match(sql, /get_user_role\(\) NOT IN \('admin','production_supervisor'\)/)
  assert.equal((sql.match(/v_run:=public\.post_production_run\(p_run,p_materials\)/g) || []).length, 1)
  assert.match(sql, /SET current_stock=current_stock-v_quantity WHERE id=v_input_id/)
  assert.match(sql, /'Semi-finished input for output '\|\|v_extra_id::text/)
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.post_multi_production_run\(JSONB,JSONB,JSONB\) FROM PUBLIC,anon/)
})

test('history shows product-specific consumption for each finished output', () => {
  assert.match(history, /production_run_additional_outputs_input_product_id_fkey/)
  assert.match(history, /input_quantity_consumed/)
  assert.match(history, /historical input not recorded/)
})
