import test from 'node:test'
import assert from 'node:assert/strict'
import { rangeFor, attachment } from './range.ts'

test('range requests', () => {
  const etag = '"abc-tar"'
  assert.deepEqual(rangeFor({}, 1000, etag), { start: 0, end: 999, partial: false })
  assert.deepEqual(rangeFor({ range: 'bytes=0-0' }, 1000, etag), { start: 0, end: 0, partial: true })
  assert.deepEqual(rangeFor({ range: 'bytes=500-' }, 1000, etag), { start: 500, end: 999, partial: true })
  assert.deepEqual(rangeFor({ range: 'bytes=-100' }, 1000, etag), { start: 900, end: 999, partial: true })
  assert.deepEqual(rangeFor({ range: 'bytes=900-5000' }, 1000, etag), { start: 900, end: 999, partial: true })
  assert.equal(rangeFor({ range: 'bytes=1000-' }, 1000, etag), null)
  assert.deepEqual(rangeFor({ range: 'bytes=0-1,5-6' }, 1000, etag), { start: 0, end: 999, partial: false }) // multipart: send it all
  // Resuming with a matching validator gets the range; a stale one gets the whole thing again
  assert.deepEqual(rangeFor({ range: 'bytes=500-', 'if-range': etag }, 1000, etag), { start: 500, end: 999, partial: true })
  assert.deepEqual(rangeFor({ range: 'bytes=500-', 'if-range': '"other"' }, 1000, etag), { start: 0, end: 999, partial: false })
})

test('download file names', () => {
  assert.equal(attachment('Show.S01E01.mkv'), 'attachment; filename="Show.S01E01.mkv"; filename*=UTF-8\'\'Show.S01E01.mkv')
  assert.equal(attachment('Фильм "1".tar'), 'attachment; filename="_____ _1_.tar"; filename*=UTF-8\'\'%D0%A4%D0%B8%D0%BB%D1%8C%D0%BC%20%221%22.tar')
})
