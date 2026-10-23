import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decide, ffmpegArgs, parseProbe, sampleAspect, TIMELINE_OFFSET } from './media.ts'
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

test('remux copies HEVC as hvc1, converts audio, maps only text subtitles and keeps the file timeline', () => {
  const args = ffmpegArgs({
    input: 'http://127.0.0.1:8080/raw/x/2',
    audio: 0,
    start: 30.15,
    mode: 'remux',
    dir: '/tmp/hls',
    transcodeMaxHeight: 720,
    info: {
      startTime: -0.005,
      video: { codec: 'hevc' },
      audio: [{ index: 0, codec: 'ac3', channels: 6, language: null, title: null, default: true }],
      subtitles: [{ index: 0, codec: 'subrip', language: null, title: null, text: true }, { index: 1, codec: 'hdmv_pgs_subtitle', language: null, title: null, text: false }],
    },
  })
  const value = (key: string, from = 0) => args[args.indexOf(key, from) + 1]
  assert.ok(args.includes('-noaccurate_seek'))
  assert.equal(Number(value('-ss')), 30.155) // -ss counts from the file's start time
  assert.equal(value('-i'), 'http://127.0.0.1:8080/raw/x/2')
  assert.equal(value('-c:v'), 'copy')
  assert.equal(value('-tag:v'), 'hvc1')
  assert.equal(value('-c:a'), 'aac')
  assert.equal(Number(value('-output_ts_offset')), 30.15 + TIMELINE_OFFSET)
  assert.match(value('-movflags') ?? '', /frag_keyframe.*frag_discont.*negative_cts_offsets/)
  assert.equal(args[args.indexOf('-use_editlist') + 2], 'pipe:3')
  assert.ok(args.includes('0:s:0'))
  assert.ok(!args.includes('0:s:1'))
  assert.equal(value('-output_ts_offset', args.indexOf('0:s:0')), '30.15') // subtitles on the plain file timeline
  assert.equal(args.at(-1), '/tmp/hls/sub_0.vtt')
})

test('transcode seeks exactly and forces keyframes on segment boundaries; a run from the start has no -ss', () => {
  const args = ffmpegArgs({ input: 'x', audio: 0, start: 1.4, mode: 'transcode', dir: '/tmp/hls', transcodeMaxHeight: 720, info: { startTime: 1.4, audio: [], subtitles: [] } })
  assert.ok(!args.includes('-ss'))
  assert.ok(!args.includes('-noaccurate_seek'))
  assert.equal(args[args.indexOf('-force_key_frames') + 1], 'expr:gte(t,n_forced*6)')
  assert.equal(args[args.indexOf('-output_ts_offset') + 1], String(1.4 + TIMELINE_OFFSET))
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
  assert.equal(parsed.startTime, 0)
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

test('keyframe indexes are cached per input; a failed read returns null and is retried next time', async () => {
  const { createMediaTools } = await import('./media.ts')
  const { box, u32 } = await import('./test-helpers.ts')
  // An MP4 whose video track has keyframes at 0 and 2 s (25 fps, timescale 12800)
  const moov = box('moov', box('trak', box('mdia',
    box('mdhd', [0, 0, 0, 0], u32(0), u32(0), u32(12_800), u32(0)),
    box('hdlr', [0, 0, 0, 0], u32(0), [...'vide'].map(c => c.charCodeAt(0))),
    box('minf', box('stbl', box('stts', [0, 0, 0, 0], u32(1), u32(100), u32(512)), box('stss', [0, 0, 0, 0], u32(2), u32(1), u32(51)))))))
  const file = Uint8Array.from([...box('ftyp', u32(0)), ...moov])
  let reads = 0
  let broken = true
  const tools = createMediaTools({
    live: () => ({ ffprobePath: 'ffprobe', ffmpegPath: 'ffmpeg', maxProbes: 1, maxSubtitleJobs: 1 }),
    readRanges: () => (start, end) => {
      reads++
      return broken ? Promise.reject(new Error('connection reset')) : Promise.resolve(file.subarray(start, end))
    },
  })
  assert.equal(await tools.keyframes('a', file.length), null)
  broken = false
  assert.deepEqual(await tools.keyframes('a', file.length), [0, 2])
  const before = reads
  assert.deepEqual(await tools.keyframes('a', file.length), [0, 2])
  assert.equal(reads, before)
})
