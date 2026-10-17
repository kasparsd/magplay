import { test } from 'node:test'
import assert from 'node:assert/strict'
import { progressKey, progressEntry, resumePosition } from './progress.js'

test('progress keys are per torrent file, separate from legacy last-episode history', () => {
  assert.equal(progressKey('abc', 2), 'progress:abc:2')
  assert.notEqual(progressKey('abc', 2), progressKey('abc', 3))
  assert.notEqual(progressKey('abc', 2), progressKey('def', 2))
})

test('meaningful progress retains absolute position, duration and save time', () => {
  const record = progressEntry(35.5, 90, { at: 123 })
  assert.deepEqual(record, { position: 35.5, duration: 90, completed: false, at: 123 })
  assert.equal(resumePosition(record, 90), 35.5)
})

test('invalid, malformed, tiny or completed progress does not offer resume', () => {
  for (const record of [null, {}, 'bad', [], { position: -1 }, { position: NaN }, { position: Infinity }, { position: '30' }, { position: 4.9 }, { position: 30, completed: true }]) {
    assert.equal(resumePosition(record, 90), 0)
  }
  for (const position of [-1, NaN, Infinity, '30']) assert.equal(progressEntry(position, 90), null)
})

test('end detection uses at most 30 seconds and never more than five percent of a short clip', () => {
  assert.equal(progressEntry(86, 90).completed, true)
  assert.equal(progressEntry(80, 90).completed, false)
  assert.equal(progressEntry(3575, 3600).completed, true)
  assert.equal(progressEntry(3550, 3600).completed, false)
  assert.equal(resumePosition({ position: 86 }, 90), 0)
})

test('actual ended events mark unknown-duration content complete; restart clears completion', () => {
  const ended = progressEntry(90, null, { ended: true })
  assert.equal(ended.completed, true)
  assert.equal(resumePosition(ended), 0)
  const restart = progressEntry(0, 90)
  assert.equal(restart.completed, false)
  assert.equal(resumePosition(restart), 0)
})

test('current duration wins over saved metadata; out-of-bounds progress restarts safely', () => {
  assert.equal(resumePosition({ position: 100, duration: 200 }, 90), 0)
  assert.equal(progressEntry(100, 90).position, 90)
  assert.equal(resumePosition({ position: 50, duration: 90 }, null), 50)
})

test('unknown or invalid durations do not falsely complete an in-progress file', () => {
  for (const duration of [null, undefined, 0, NaN, Infinity, -1]) {
    const record = progressEntry(30, duration)
    assert.equal(record.duration, null)
    assert.equal(record.completed, false)
    assert.equal(resumePosition(record), 30)
  }
})
