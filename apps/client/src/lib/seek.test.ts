import { test } from 'node:test'
import assert from 'node:assert/strict'
import { canSeekLocally, layerBackground, seekHint, seekOutcome, spans } from './seek.ts'
import type { SeekContext } from './seek.ts'

const hls = (over: Partial<SeekContext> = {}): SeekContext => ({
  mode: 'remux', offset: 60, duration: 600, buffered: [[0, 20]], seekable: [[0, 40]], ranges: [[0, 0.5]], ...over,
})

test('spans reads TimeRanges-like objects', () => {
  const ranges = { length: 2, start: (i: number) => [0, 10][i] ?? 0, end: (i: number) => [5, 20][i] ?? 0 }
  assert.deepEqual(spans(ranges), [[0, 5], [10, 20]])
})

test('HLS outcomes: buffer, seekable session, restart on the server, missing', () => {
  assert.equal(seekOutcome(70, hls()), 'buffered')
  assert.equal(seekOutcome(90, hls()), 'seekable')
  // seekTo stays 2 s inside the seekable end, so the tooltip does too
  assert.equal(seekOutcome(99, hls()), 'restart')
  assert.equal(seekOutcome(30, hls()), 'restart') // before the session's offset
  assert.equal(seekOutcome(400, hls()), 'missing') // past half of the file
  assert.equal(seekHint('restart'), 'Restarts conversion here')
  assert.equal(seekHint('missing'), 'Not downloaded yet. Starts when peers send it.')
  assert.equal(seekHint('seekable'), '')
})

test('direct outcomes depend only on the buffer and the server', () => {
  const direct = hls({ mode: 'direct', offset: 0, seekable: [[0, 600]], buffered: [[0, 30]] })
  assert.equal(seekOutcome(10, direct), 'buffered')
  assert.equal(seekOutcome(200, direct), 'seekable')
  assert.equal(seekOutcome(500, direct), 'missing')
  assert.equal(seekOutcome(500, { ...direct, ranges: null }), 'seekable') // unknown until the first poll
})

test('local seeks need the browser\'s seekable range, with 2 s slack at the end', () => {
  assert.equal(canSeekLocally(10, [[0, 30]]), true)
  assert.equal(canSeekLocally(29, [[0, 30]]), false)
  assert.equal(canSeekLocally(5, []), false)
})

test('layer backgrounds merge ranges into one gradient', () => {
  assert.equal(layerBackground([], 'red'), 'none')
  assert.equal(layerBackground([[0.5, 0.75], [0, 0.25], [0.2, 0.3]], 'red'),
    'linear-gradient(to right, transparent 0%, red 0%, red 30%, transparent 30%, transparent 50%, red 50%, red 75%, transparent 75%)')
})
