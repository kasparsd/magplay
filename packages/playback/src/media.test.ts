import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decide, ffmpegArgs, parseProbe, sampleAspect } from './media.ts'
import type { DecideInput, MediaInfo } from './media.ts'
import { MediaToolError, NoSuchTrackError, UnplayableError } from './errors.ts'

const info = (overrides: Partial<DecideInput> = {}): DecideInput => ({
  container: 'mov,mp4,m4a,3gp,3g2,mj2',
  isWebm: false,
  video: { codec: 'h264', bitDepth: 8, tag: 'avc1' },
  audio: [{ codec: 'aac' }],
  ...overrides,
})
const caps = { h264: true, aac: true, hevc: true, vp9: true, opus: true }
const policy = { allowTranscode: false, transcodeMaxHeight: 720 }

test('supported MP4 plays directly; MKV and alternate audio use remux', () => {
  assert.equal(decide(info(), caps, policy).mode, 'direct')
  assert.equal(decide(info({ container: 'matroska,webm' }), caps, policy).mode, 'remux')
  assert.equal(decide(info({ audio: [{ codec: 'aac' }, { codec: 'aac' }] }), caps, policy, 1).mode, 'remux')
  assert.equal(decide(info({ audio: [{ codec: 'ac3' }] }), caps, policy).mode, 'remux')
})

test('WebM, silent video, and HEVC container tags', () => {
  assert.equal(decide(info({ isWebm: true, video: { codec: 'vp9', bitDepth: 8, tag: '' }, audio: [{ codec: 'opus' }] }), caps, policy).mode, 'direct')
  assert.equal(decide(info({ audio: [] }), caps, policy).mode, 'direct')
  assert.equal(decide(info({ video: { codec: 'hevc', bitDepth: 10, tag: 'hev1' } }), caps, policy).mode, 'remux')
})

test('unsupported video transcodes only when the policy allows it', () => {
  const av1 = info({ video: { codec: 'av1', bitDepth: 8, tag: '' } })
  assert.throws(() => decide(av1, { aac: true }, policy), UnplayableError)
  const allowed = decide(av1, { aac: true }, { allowTranscode: true, transcodeMaxHeight: 1080 })
  assert.equal(allowed.mode, 'transcode')
  assert.match(allowed.reason, /H\.264 1080p/)
})

test('invalid audio selections and missing video have typed errors', () => {
  for (const track of [-1, 0.5, 99, NaN]) assert.throws(() => decide(info(), caps, policy, track), NoSuchTrackError)
  assert.throws(() => decide(info({ video: null }), caps, policy), UnplayableError)
})

test('remux copies HEVC as hvc1, converts audio and maps only text subtitles', () => {
  const args = ffmpegArgs({
    input: 'http://127.0.0.1:8080/raw/x/2',
    audio: 0,
    start: 30,
    mode: 'remux',
    dir: '/tmp/hls',
    transcodeMaxHeight: 720,
    info: {
      video: { codec: 'hevc' },
      audio: [{ index: 0, codec: 'ac3', channels: 6, language: null, title: null, default: true }],
      subtitles: [{ index: 0, codec: 'subrip', language: null, title: null, text: true }, { index: 1, codec: 'hdmv_pgs_subtitle', language: null, title: null, text: false }],
    },
  })
  const value = (key: string) => args[args.indexOf(key) + 1]
  assert.equal(value('-ss'), '30')
  assert.equal(value('-i'), 'http://127.0.0.1:8080/raw/x/2')
  assert.equal(value('-c:v'), 'copy')
  assert.equal(value('-tag:v'), 'hvc1')
  assert.equal(value('-c:a'), 'aac')
  assert.ok(args.includes('0:s:0'))
  assert.ok(!args.includes('0:s:1'))
})

test('sample aspect ratios: anamorphic, square and unknown', () => {
  assert.equal(sampleAspect('4:3'), 4 / 3)
  assert.equal(sampleAspect('1:1'), 1)
  for (const value of [undefined, '', '0:1', 'N/A', '1:0']) assert.equal(sampleAspect(value), 1)
})

test('ffprobe JSON parses into tracks; junk is a media tool error', () => {
  const parsed: MediaInfo = parseProbe({
    format: { duration: '61.5', format_name: 'matroska,webm' },
    streams: [
      { codec_type: 'video', codec_name: 'mjpeg', disposition: { attached_pic: 1 } },
      { codec_type: 'video', codec_name: 'hevc', codec_tag_string: 'hev1', profile: 'Main 10', width: 1920, height: 1080, pix_fmt: 'yuv420p10le', sample_aspect_ratio: '1:1' },
      { codec_type: 'audio', codec_name: 'eac3', channels: 6, tags: { language: 'eng', title: 'Surround' }, disposition: { default: 1 } },
      { codec_type: 'audio', codec_name: 'aac', channels: 2, tags: { language: 'und' } },
      { codec_type: 'subtitle', codec_name: 'subrip', tags: { language: 'lav' } },
      { codec_type: 'subtitle', codec_name: 'hdmv_pgs_subtitle' },
    ],
  }, 'Show.S01E01.mkv')
  assert.equal(parsed.duration, 61.5)
  assert.deepEqual(parsed.video, { codec: 'hevc', tag: 'hev1', profile: 'Main 10', width: 1920, height: 1080, sampleAspect: 1, bitDepth: 10 })
  assert.deepEqual(parsed.audio.map(a => [a.index, a.codec, a.language, a.default]), [[0, 'eac3', 'eng', true], [1, 'aac', null, false]])
  assert.deepEqual(parsed.subtitles.map(s => [s.index, s.text, s.language]), [[0, true, 'lav'], [1, false, null]])
  assert.equal('video' in parseProbe({ streams: [] }, 'x.mp4'), false)
  for (const junk of [null, [], 'x', { streams: {} }]) assert.throws(() => parseProbe(junk, 'x'), MediaToolError)
})
