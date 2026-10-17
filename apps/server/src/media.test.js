import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decide, ffmpegArgs } from './media.js'

const info = (overrides = {}) => ({
  container: 'mov,mp4,m4a,3gp,3g2,mj2',
  isWebm: false,
  video: { codec: 'h264', bitDepth: 8 },
  audio: [{ codec: 'aac' }],
  subtitles: [],
  ...overrides,
})
const caps = { h264: true, aac: true, hevc: true, vp9: true, opus: true }

test('supported MP4 plays directly; MKV and alternate audio use remux', () => {
  assert.equal(decide(info(), caps, 0).mode, 'direct')
  assert.equal(decide(info({ container: 'matroska,webm' }), caps, 0).mode, 'remux')
  assert.equal(decide(info({ audio: [{ codec: 'aac' }, { codec: 'aac' }] }), caps, 1).mode, 'remux')
  assert.equal(decide(info({ audio: [{ codec: 'ac3' }] }), caps, 0).mode, 'remux')
})

test('WebM, silent video, and HEVC container tags', () => {
  assert.equal(decide(info({ isWebm: true, video: { codec: 'vp9' }, audio: [{ codec: 'opus' }] }), caps, 0).mode, 'direct')
  assert.equal(decide(info({ audio: [] }), caps, 0).mode, 'direct')
  assert.equal(decide(info({ video: { codec: 'hevc', bitDepth: 10, tag: 'hev1' } }), caps, 0).mode, 'remux')
})

test('invalid audio selections and missing video have useful HTTP errors', () => {
  for (const track of [-1, 0.5, 99, NaN]) assert.throws(() => decide(info(), caps, track), { status: 400 })
  assert.throws(() => decide(info({ video: null }), caps, 0), { status: 422 })
})

test('remux copies HEVC as hvc1, converts audio and maps only text subtitles', () => {
  const args = ffmpegArgs({
    ih: 'a'.repeat(40),
    idx: 2,
    audio: 0,
    start: 30,
    mode: 'remux',
    dir: '/tmp/hls',
    info: info({ video: { codec: 'hevc' }, audio: [{ codec: 'ac3' }], subtitles: [{ index: 0, text: true }, { index: 1, text: false }] })
  })
  const value = key => args[args.indexOf(key) + 1]
  assert.equal(value('-ss'), '30')
  assert.equal(value('-c:v'), 'copy')
  assert.equal(value('-tag:v'), 'hvc1')
  assert.equal(value('-c:a'), 'aac')
  assert.ok(args.includes('0:s:0'))
  assert.ok(!args.includes('0:s:1'))
})
