import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatBytes } from './format.ts'

test('file sizes preserve small downloads while retaining decimal MB and GB formatting', () => {
  const cases: Array<[number | null | undefined, string]> = [
    [null, ''], [undefined, ''], [0, '0 B'], [58, '58 B'], [999, '999 B'],
    [1000, '1 KB'], [16_500, '17 KB'], [1_000_000, '1 MB'],
    [500_000_000, '500 MB'], [1_500_000_000, '1.5 GB'],
  ]
  for (const [bytes, expected] of cases) assert.equal(formatBytes(bytes), expected)
})
