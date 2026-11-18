import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const productionPage = readFileSync(resolve(import.meta.dirname, '../src/pages/production/ProductionPage.tsx'), 'utf8')

test('production history disambiguates the output and input product joins', () => {
  assert.match(productionPage, /finished_goods:finished_goods!production_run_additional_outputs_finished_good_id_fkey\(product_name,stage\)/)
  assert.match(productionPage, /input_product:finished_goods!production_run_additional_outputs_input_product_id_fkey\(product_name,unit\)/)
  assert.doesNotMatch(productionPage, /[, ]finished_goods\(product_name,stage\)\)/)
})
