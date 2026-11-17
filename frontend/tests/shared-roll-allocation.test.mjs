import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { checkRollPortions } from '../src/lib/rollAllocations.ts'

const root = resolve(import.meta.dirname, '../..')
const read = (path) => readFileSync(resolve(root,path),'utf8')
const sql = read('supabase/migrations/20261117000028_shared_semi_finished_roll_allocations.sql')
const form = read('frontend/src/pages/production/ProductionRunForm.tsx')

// Pure computations test the same validation used by the production form.
test('one 50 kg, 30-micron semi-finished roll can supply 20 kg + 15 kg to two finished outputs',()=>{
  assert.equal(checkRollPortions({'roll-30':50},[
    {roll_id:'roll-30',weight_kg:20},
    {roll_id:'roll-30',weight_kg:15},
  ]),null)
})

test('shared roll allocation rejects overconsumption, invalid precision, and unavailable source rolls',()=>{
  assert.match(checkRollPortions({'roll-30':50},[
    {roll_id:'roll-30',weight_kg:30},
    {roll_id:'roll-30',weight_kg:25},
  ]),/exceeds/)
  assert.match(checkRollPortions({'roll-30':50},[
    {roll_id:'roll-30',weight_kg:1.234},
  ]),/decimal places/)
  assert.match(checkRollPortions({'roll-30':50},[
    {roll_id:'does-not-exist',weight_kg:10},
  ]),/no longer available/)
  assert.equal(checkRollPortions({'roll-30':50},[
    {roll_id:'roll-30',weight_kg:0.29},
  ]),null)
})

test('new SQL protects partial roll balances and only decrements roll-count stock on depletion',()=>{
  assert.match(sql,/ADD COLUMN original_weight_kg NUMERIC/)
  assert.match(sql,/input_accounting_mode='allocated_kg'/)
  assert.match(sql,/production_run_roll_allocations/)
  assert.match(sql,/FOR UPDATE/)
  assert.match(sql,/v_used>v_roll\.weight_kg/)
  assert.match(sql,/SET weight_kg=v_left/)
  assert.match(sql,/IF v_left=0 THEN/)
  assert.match(sql,/current_stock=current_stock-1/)
  assert.match(sql,/status=CASE WHEN v_left=0 THEN 'consumed'/)
  assert.match(sql,/SECURITY DEFINER/)
  assert.match(sql,/get_user_role\(\) NOT IN \('admin','production_supervisor'\)/)
  assert.match(sql,/REVOKE ALL ON TABLE public\.production_run_roll_allocations FROM PUBLIC,anon,authenticated/)
})

test('UI records measured portions for each finished product and calls secured atomic RPC',()=>{
  assert.match(form,/primaryRollWeights/)
  assert.match(form,/input_roll_weights/)
  assert.match(form,/input_roll_allocations:/)
  assert.match(form,/checkRollPortions/)
  assert.match(form,/post_allocated_conversion_run/)
  assert.match(form,/Same physical roll/i) // added explanatory guidance
})
