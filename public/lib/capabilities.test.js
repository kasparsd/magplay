import { test } from 'node:test'
import assert from 'node:assert/strict'
import { measureCaps } from './capabilities.js'

// Exact MIME probes are a compatibility contract with the existing player.
const types = {
  h264: 'video/mp4; codecs="avc1.640028"',
  hevc: 'video/mp4; codecs="hvc1.1.6.L120.90"',
  vp9: 'video/webm; codecs="vp9"',
  av1: 'video/mp4; codecs="av01.0.08M.08"',
  aac: 'audio/mp4; codecs="mp4a.40.2"',
  ac3: 'audio/mp4; codecs="ac-3"',
  eac3: 'audio/mp4; codecs="ec-3"',
  opus: 'audio/webm; codecs="opus"',
  flac: 'audio/mp4; codecs="flac"',
}
const all = supported => Object.fromEntries(Object.keys(types).map(key => [key, supported]))

test('capability helper imports without DOM/window and reports every server codec key', () => {
  assert.equal(typeof window, 'undefined')
  assert.equal(typeof document, 'undefined')
  assert.deepEqual(measureCaps({ canPlayType: () => '' }), all(false))
})

test('MSE receives the unchanged MIME probes and supported types need no native fallback', () => {
  const calls = []
  const MediaSource = {
    isTypeSupported (type) {
      assert.equal(this, MediaSource)
      calls.push(type)
      return true
    },
  }
  const result = measureCaps({ canPlayType: () => assert.fail('native fallback should short-circuit') }, { MediaSource })
  assert.deepEqual(calls, Object.values(types))
  assert.deepEqual(result, all(true))
})

test('native playback is a fallback when MediaSource is absent or lacks its static API', () => {
  for (const browser of [{}, { MediaSource: {} }, { ManagedMediaSource: {} }]) {
    const calls = []
    const video = { canPlayType (type) { assert.equal(this, video); calls.push(type); return 'probably' } }
    assert.deepEqual(measureCaps(video, browser), all(true))
    assert.deepEqual(calls, Object.values(types))
  }
})

test('native maybe/empty hints stay unsupported; only probably enables the codec', () => {
  const video = { canPlayType: type => type === types.h264 ? 'probably' : type === types.hevc ? 'maybe' : '' }
  assert.deepEqual(measureCaps(video), { ...all(false), h264: true })
})

test('mixed MSE and native support combines per codec without user-agent assumptions', () => {
  const mse = new Set([types.h264, types.aac])
  const video = { canPlayType: type => type === types.opus ? 'probably' : 'maybe' }
  const caps = measureCaps(video, { MediaSource: { isTypeSupported: type => mse.has(type) } })
  assert.deepEqual(caps, { ...all(false), h264: true, aac: true, opus: true })
  assert.ok(Object.values(caps).every(value => typeof value === 'boolean'))
})

test('ManagedMediaSource retains precedence even when MediaSource would support more codecs', () => {
  class ManagedMediaSource {
    static isTypeSupported (type) { return type === types.hevc }
  }
  const MediaSource = { isTypeSupported: () => assert.fail('must not override ManagedMediaSource') }
  assert.deepEqual(measureCaps({ canPlayType: () => '' }, { ManagedMediaSource, MediaSource }), { ...all(false), hevc: true })
})

test('measurements are fresh per call and do not mutate caller-owned browser objects', () => {
  let supported = false
  const video = Object.freeze({ canPlayType: () => '' })
  const browser = Object.freeze({ MediaSource: Object.freeze({ isTypeSupported: () => supported }) })
  const first = measureCaps(video, browser)
  first.h264 = true
  assert.deepEqual(measureCaps(video, browser), all(false))
  supported = true
  assert.deepEqual(measureCaps(video, browser), all(true))
})
