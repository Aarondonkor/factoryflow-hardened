import test from 'node:test'
import assert from 'node:assert/strict'
import { formatCurrency,formatDate,toInputDate,formatItemSpec,formatKg } from '../src/lib/format.ts'

test('Ghana-local date-only values do not change days',()=>{
  assert.equal(toInputDate(new Date('2026-11-07T23:58:00Z')),'2026-11-07')
  assert.equal(formatDate('2026-11-07'),'07/11/2026')
  assert.equal(formatDate(null),'—')
})
test('monetary and inventory units are labelled, not silently mixed',()=>{
  assert.match(formatCurrency(120.25),/120\.25/)
  assert.equal(formatItemSpec({specified_micron:35}),' (35µ)')
  assert.match(formatKg(12.34),/12\.34 kg/)
})
