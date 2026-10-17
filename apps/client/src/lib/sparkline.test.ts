import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pathData, segments } from './sparkline.ts'

test('series are right-aligned, clipped to max and split at gaps', () => {
  assert.deepEqual(segments([0, 50, null, 200], 6, 100), [[[2, 100], [3, 50]], [[5, 0]]])
  assert.deepEqual(segments([], 6, 100), [])
})

test('paths for lines, areas and single points', () => {
  assert.equal(pathData([[0, 100], [1, 50]], false), 'M0,100 L1,50')
  assert.equal(pathData([[0, 100], [1, 50]], true), 'M0,100 L1,50 L1,100 L0,100 Z')
  assert.equal(pathData([[3, 20]], false), 'M2.5,20 L3.5,20')
})
