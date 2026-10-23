import { test } from 'node:test'
import assert from 'node:assert/strict'
import { layerBackground, seekHint, seekOutcome, seekTarget, spans } from './seek.ts'
import type { SeekContext } from './seek.ts'

const hls = (over: Partial<SeekContext> = {}): SeekContext => ({
  mode: 'remux', duration: 600, buffered: [[60, 80]], ready: [[0, 120], [400, 420]], growingEnd: null, ranges: [[0, 0.5]], ...over,
})

test('spans reads TimeRanges-like objects', () => {
  const ranges = { length: 2, start: (i: number) => [0, 10][i] ?? 0, end: (i: number) => [5, 20][i] ?? 0 }
  assert.deepEqual(spans(ranges), [[0, 5], [10, 20]])
})

test('HLS outcomes: buffer, converted, converts on the server, missing', () => {
  assert.equal(seekOutcome(70, hls()), 'buffered')
  assert.equal(seekOutcome(100, hls()), 'seekable')
  assert.equal(seekOutcome(410, hls()), 'seekable') // converted even though the bytes aren't all on the server
  assert.equal(seekOutcome(200, hls()), 'convert')
  assert.equal(seekOutcome(500, hls()), 'missing') // past half of the file
  assert.equal(seekOutcome(200, hls({ ready: null })), 'seekable') // unknown until the first poll
  assert.equal(seekHint('convert'), 'Converts from here')
  assert.equal(seekHint('missing'), 'Not downloaded yet. Starts when peers send it.')
  assert.equal(seekHint('seekable'), '')
})

test('a growing playlist can only be seeked as far as it has been converted', () => {
  const growing = hls({ growingEnd: 130 })
  assert.equal(seekOutcome(100, growing), 'seekable')
  assert.equal(seekOutcome(129.5, growing), 'unconverted')
  assert.equal(seekOutcome(300, growing), 'unconverted')
  assert.equal(seekHint('unconverted'), 'Not converted yet')
  assert.equal(seekTarget(300, 130), 129)
  assert.equal(seekTarget(300, null), 300)
  assert.equal(seekTarget(10, 0.5), 0)
})

test('a browser remux converts from any point outside its buffer that is on the server', () => {
  const browser = hls({ mode: 'browser-remux', ready: null })
  assert.equal(seekOutcome(70, browser), 'buffered')
  assert.equal(seekOutcome(200, browser), 'convert')
  assert.equal(seekOutcome(500, browser), 'missing')
})

test('direct outcomes depend only on the buffer and the server', () => {
  const direct = hls({ mode: 'direct', ready: null, buffered: [[0, 30]] })
  assert.equal(seekOutcome(10, direct), 'buffered')
  assert.equal(seekOutcome(200, direct), 'seekable')
  assert.equal(seekOutcome(500, direct), 'missing')
  assert.equal(seekOutcome(500, { ...direct, ranges: null }), 'seekable') // unknown until the first poll
})

test('layer backgrounds merge ranges into one gradient', () => {
  assert.equal(layerBackground([], 'red'), 'none')
  assert.equal(layerBackground([[0.5, 0.75], [0, 0.25], [0.2, 0.3]], 'red'),
    'linear-gradient(to right, transparent 0%, red 0%, red 30%, transparent 30%, transparent 50%, red 50%, red 75%, transparent 75%)')
})
