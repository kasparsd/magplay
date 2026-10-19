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

test('HLS sessions keep track start offsets in fragment timestamps, never in edit lists', () => {
  const options = { input: '/raw/x/2', audio: 0, mode: 'remux' as const, dir: '/tmp/hls', transcodeMaxHeight: 720, info: { video: { codec: 'h264' }, audio: [{ index: 0, codec: 'ac3', channels: 6, language: null, title: null, default: true }], subtitles: [] } }
  const resumed = ffmpegArgs({ ...options, start: 36.5 })
  const value = (args: string[], key: string) => args[args.indexOf(key) + 1]
  // Converted audio must start where copied video does: the keyframe the seek lands on, not a later trim
  assert.deepEqual(resumed.slice(resumed.indexOf('-noaccurate_seek'), resumed.indexOf('-i') + 1), ['-noaccurate_seek', '-ss', '36.5', '-i'])
  // Edit lists are ignored by MSE; skip_sidx keeps an open GOP's first sample from being moved onto the previous segment
  assert.equal(value(resumed, '-hls_segment_options'), 'use_editlist=0:movflags=+frag_discont+skip_sidx:avoid_negative_ts=disabled')
  assert.equal(value(resumed, '-hls_segment_type'), 'fmp4')
  const fresh = ffmpegArgs({ ...options, start: 0 })
  assert.ok(!fresh.includes('-ss') && !fresh.includes('-noaccurate_seek'))
  assert.equal(value(fresh, '-hls_segment_options'), value(resumed, '-hls_segment_options'))
  // Re-encoded video can begin on the requested frame, so it does not disable accurate seeking
  const transcode = ffmpegArgs({ ...options, mode: 'transcode', start: 36.5 })
  assert.equal(transcode.includes('-noaccurate_seek'), false)
  assert.equal(value(transcode, '-ss'), '36.5')
  assert.equal(value(transcode, '-hls_segment_options'), value(resumed, '-hls_segment_options'))
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

test('probe results are cached per input, keeping only the most recently used', async t => {
  const fs = await import('node:fs/promises')
  const os = await import('node:os')
  const path = await import('node:path')
  const { createMediaTools } = await import('./media.ts')
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'magplay-probe-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  // A stand-in ffprobe that counts its runs and reports one H.264 stream
  const runs = path.join(dir, 'runs')
  const ffprobe = path.join(dir, 'ffprobe')
  await fs.writeFile(ffprobe, `#!/bin/sh\necho x >> "${runs}"\necho '{"format":{"format_name":"mov,mp4,m4a,3gp,3g2,mj2","duration":"10"},"streams":[{"index":0,"codec_type":"video","codec_name":"h264","codec_tag_string":"avc1","width":2,"height":2}]}'\n`, { mode: 0o755 })
  const tools = createMediaTools({ live: () => ({ ffprobePath: ffprobe, ffmpegPath: 'ffmpeg', maxProbes: 2, maxSubtitleJobs: 1 }), probeCacheLimit: 2 })
  const count = async (): Promise<number> => (await fs.readFile(runs, 'utf8')).split('\n').filter(Boolean).length
  await tools.probe('a', 'a.mp4')
  await tools.probe('b', 'b.mp4')
  await tools.probe('a', 'a.mp4') // cached, and now the most recent
  await tools.probe('c', 'c.mp4') // evicts b
  assert.equal(await count(), 3)
  assert.deepEqual(tools.stats().probeCache, { used: 2, limit: 2 })
  await tools.probe('a', 'a.mp4')
  assert.equal(await count(), 3)
  await tools.probe('b', 'b.mp4')
  assert.equal(await count(), 4)
})
