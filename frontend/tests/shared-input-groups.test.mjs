import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..','..')
const migration=readFileSync(resolve(root,'supabase/migrations/20261127000032_shared_conversion_input_groups.sql'),'utf8')
const form=readFileSync(resolve(root,'frontend/src/pages/production/ProductionRunForm.tsx'),'utf8')
const page=readFileSync(resolve(root,'frontend/src/pages/production/ProductionPage.tsx'),'utf8')

test('shared input groups have dedicated ledger and member/output links',()=>{
  assert.match(migration,/CREATE TABLE public\.production_run_input_groups/)
  assert.match(migration,/CREATE TABLE public\.production_run_input_group_outputs/)
  assert.match(migration,/CREATE TABLE public\.production_run_input_group_rolls/)
  assert.match(migration,/UNIQUE NULLS NOT DISTINCT \(production_run_id,production_output_id\)/)
})
test('shared posting is admin-controlled, atomic and uses roll row locks',()=>{
  assert.match(migration,/CREATE OR REPLACE FUNCTION public\.post_shared_conversion_run/)
  assert.match(migration,/public\.get_user_role\(\) NOT IN \('admin','production_supervisor'\)/)
  assert.match(migration,/ORDER BY id FOR UPDATE/)
  assert.match(migration,/v_left:=v_roll\.weight_kg-v_roll_used/)
  assert.match(migration,/input_accounting_mode/)
  assert.match(migration,/shared_groups/)
})
test('same roll cannot be deducted more than once in shared mode',()=>{
  assert.match(migration,/A physical roll cannot be counted in two shared input groups/)
  assert.match(migration,/v_roll_used>v_roll\.weight_kg/)
})
test('shared mode does not invent individual brand input quantities',()=>{
  assert.match(migration,/v_extra_row\.quality_grade,NULL,NULL/)
  assert.match(form,/inputRecordingMode/)
  assert.match(form,/Shared total by input material/)
  assert.match(form,/output_indices/)
  assert.match(form,/post_shared_conversion_run/)
  assert.match(page,/production_run_input_groups/)
})
