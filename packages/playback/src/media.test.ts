import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decide, detectTranscodeEncoders, ffmpegArgs, resolveTranscodeEncoder, TIMELINE_OFFSET } from './media.ts'
import type { DecideInput, EncoderCommandRunner } from './media.ts'
import { NoSuchTrackError, UnplayableError } from './errors.ts'

const info = (overrides: Partial<DecideInput> = {}): DecideInput => ({
  container: 'mp4',
  isWebm: false,
  video: { codec: 'h264', bitDepth: 8, tag: 'avc1' },
  audio: [{ codec: 'aac' }],
  ...overrides,
})
const caps = { h264: true, aac: true, hevc: true, vp9: true, opus: true }
const policy = { serverConversion: true, allowTranscode: false, transcodeMaxHeight: 720 }
const core = { ...policy, serverConversion: false }

test('supported MP4 plays directly; MKV and alternate audio use remux', () => {
  assert.equal(decide(info(), caps, policy).mode, 'direct')
  assert.equal(decide(info({ container: 'matroska' }), caps, policy).mode, 'remux')
  assert.equal(decide(info({ audio: [{ codec: 'aac' }, { codec: 'aac' }] }), caps, policy, 1).mode, 'remux')
  assert.equal(decide(info({ audio: [{ codec: 'ac3' }] }), caps, policy).mode, 'remux')
})

test('without ffmpeg the browser remuxes what it can demux and decode; nothing is transcoded', () => {
  assert.equal(decide(info(), caps, core).mode, 'direct')
  const mkv = decide(info({ container: 'matroska', audio: [{ codec: 'ac3' }] }), caps, core)
  assert.equal(mkv.mode, 'browser-remux')
  assert.equal(decide(info({ container: 'matroska', audio: [{ codec: 'ac3' }] }), caps, core, 0, false).mode, 'node-remux')
  assert.match(mkv.reason, /converting ac3 audio to AAC, in the browser/)
  assert.throws(() => decide(info({ container: 'avi' }), caps, core), UnplayableError)
  assert.throws(() => decide(info({ container: 'matroska', audio: [{ codec: 'truehd' }] }), caps, core), UnplayableError)
  assert.throws(() => decide(info({ video: { codec: 'av1', bitDepth: 8, tag: '' } }), caps, { ...core, allowTranscode: true }), /no ffmpeg/)
})

test('WebM, silent video, and HEVC container tags', () => {
  assert.equal(decide(info({ isWebm: true, video: { codec: 'vp9', bitDepth: 8, tag: '' }, audio: [{ codec: 'opus' }] }), caps, policy).mode, 'direct')
  assert.equal(decide(info({ audio: [] }), caps, policy).mode, 'direct')
  assert.equal(decide(info({ video: { codec: 'hevc', bitDepth: 10, tag: 'hev1' } }), caps, policy).mode, 'remux')
})

test('unsupported video transcodes only when the policy allows it', () => {
  const av1 = info({ video: { codec: 'av1', bitDepth: 8, tag: '' } })
  assert.throws(() => decide(av1, { aac: true }, policy), UnplayableError)
  const allowed = decide(av1, { aac: true }, { ...policy, allowTranscode: true, transcodeMaxHeight: 1080 })
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
  assert.match(value('-movflags') ?? '', /frag_keyframe.*frag_discont/)
  assert.equal(value('-avoid_negative_ts'), 'disabled')
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

test('HLS runs keep track start offsets in fragment timestamps, never in edit lists', () => {
  const options = { input: '/raw/x/2', audio: 0, mode: 'remux' as const, dir: '/tmp/hls', transcodeMaxHeight: 720, info: { startTime: 0, video: { codec: 'h264' }, audio: [{ index: 0, codec: 'ac3', channels: 6, language: null, title: null, default: true }], subtitles: [] } }
  const resumed = ffmpegArgs({ ...options, start: 36.5 })
  const value = (args: string[], key: string) => args[args.indexOf(key) + 1]
  // Converted audio must start where copied video does: the keyframe the seek lands on, not a later trim
  assert.deepEqual(resumed.slice(resumed.indexOf('-noaccurate_seek'), resumed.indexOf('-i') + 1), ['-noaccurate_seek', '-ss', '36.5', '-i'])
  // Edit lists are ignored by MSE: every start offset is in tfdt
  assert.equal(value(resumed, '-use_editlist'), '0')
  assert.match(value(resumed, '-movflags') ?? '', /frag_discont/)
  // Copied video keeps the container's timebase, so millisecond MKV timestamps are not rounded into a codec-derived one
  assert.deepEqual(resumed.slice(resumed.indexOf('-c:v'), resumed.indexOf('-c:v') + 4), ['-c:v', 'copy', '-copytb', '1'])
  const fresh = ffmpegArgs({ ...options, start: 0 })
  assert.ok(!fresh.includes('-ss'))
  // Re-encoded video can begin on the requested frame, so it does not disable accurate seeking
  const transcode = ffmpegArgs({ ...options, mode: 'transcode', start: 36 })
  assert.equal(transcode.includes('-noaccurate_seek'), false)
  assert.equal(transcode.includes('-copytb'), false)
  assert.equal(value(transcode, '-ss'), '36')
  // A resolved hardware encoder is written through; argument building does not run detection again
  const vaapi = ffmpegArgs({ ...options, mode: 'transcode', start: 0, transcodeEncoder: 'h264_vaapi', vaapiDevice: '/dev/dri/renderD129' })
  assert.equal(value(vaapi, '-c:v'), 'h264_vaapi')
  assert.equal(value(vaapi, '-vaapi_device'), '/dev/dri/renderD129')
  assert.equal(value(vaapi, '-force_key_frames'), 'expr:gte(t,n_forced*6)')
})

const encoderList = (...encoders: string[]): string => encoders.map(encoder => ` V..... ${encoder} test encoder`).join('\n')

test('hardware encoder detection requires a successful one-frame probe', async () => {
  const { createLogging } = await import('@magplay/observability')
  const logging = createLogging({ level: 'debug', sink: { write () {} } })
  const commands: string[][] = []
  const run: EncoderCommandRunner = (_command, args) => {
    commands.push(args)
    if (args.includes('-encoders')) return Promise.resolve({ stdout: encoderList('h264_vaapi', 'libx264') })
    return Promise.reject(new Error('No VA display found'))
  }
  const available = await detectTranscodeEncoders('fake-ffmpeg', { vaapiDevice: '/dev/dri/custom', logger: logging.logger, run })
  assert.deepEqual(available, ['libx264'])
  assert.equal(resolveTranscodeEncoder('auto', available), 'libx264')
  assert.equal(resolveTranscodeEncoder('h264_vaapi', available), 'libx264')
  assert.deepEqual(commands[1], [
    '-hide_banner', '-nostdin', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'nullsrc=s=16x16:d=0.1', '-frames:v', '1',
    '-vaapi_device', '/dev/dri/custom', '-vf', 'format=nv12,hwupload',
    '-c:v', 'h264_vaapi', '-f', 'null', '-',
  ])
  assert.equal(logging.tail().filter(record => record.event === 'ffmpeg.encoder.probe.failed').length, 1)
})

test('a compiled hardware encoder is available only after its probe succeeds', async () => {
  const run: EncoderCommandRunner = (_command, args) => Promise.resolve({
    stdout: args.includes('-encoders') ? encoderList('h264_qsv', 'libx264') : '',
  })
  const available = await detectTranscodeEncoders('fake-ffmpeg', { run })
  assert.deepEqual(available, ['h264_qsv', 'libx264'])
  assert.equal(resolveTranscodeEncoder('auto', available), 'h264_qsv')
})

test('encoder-list failure still returns no available encoders', async () => {
  const run: EncoderCommandRunner = () => Promise.reject(new Error('ffmpeg missing'))
  assert.deepEqual(await detectTranscodeEncoders('fake-ffmpeg', { run }), [])
})

test('probe results are cached per input, keeping only the most recently used', async t => {
  const fs = await import('node:fs/promises')
  const os = await import('node:os')
  const path = await import('node:path')
  const { createMediaTools } = await import('./media.ts')
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'magplay-probe-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const fixture = await fs.readFile(path.join(import.meta.dirname, '../test-fixtures/h264-aac.mp4'))
  for (const name of ['a', 'b', 'c']) await fs.writeFile(path.join(dir, name), fixture)
  const tools = createMediaTools({ live: () => ({ ffmpegPath: 'ffmpeg', maxProbes: 2, maxSubtitleJobs: 1 }), probeCacheLimit: 2 })
  const file = (name: string): string => path.join(dir, name)
  const a1 = await tools.probe(file('a'), 'a.mp4')
  await tools.probe(file('b'), 'b.mp4')
  assert.equal(await tools.probe(file('a'), 'a.mp4'), a1) // cached, and now the most recent
  await tools.probe(file('c'), 'c.mp4') // evicts b
  assert.deepEqual(tools.stats().probeCache, { used: 2, limit: 2 })
  assert.equal(await tools.probe(file('a'), 'a.mp4'), a1)
  await fs.rm(file('b'))
  await assert.rejects(tools.probe(file('b'), 'b.mp4')) // not cached any more: it reads the file again, which evicts c
  assert.deepEqual(tools.stats().probeCache, { used: 1, limit: 2 }) // and a failure is not kept
  assert.equal(await tools.probe(file('a'), 'a.mp4'), a1)
})

test('ffmpeg detection reports a missing binary as no server conversion', async () => {
  const { createMediaTools } = await import('./media.ts')
  const tools = createMediaTools({ live: () => ({ ffmpegPath: '/nonexistent/ffmpeg', maxProbes: 1, maxSubtitleJobs: 1 }) })
  assert.equal(tools.ffmpeg(), null)
  assert.equal(tools.serverConversion(), true) // assumed until checked
  assert.deepEqual(await tools.refreshFfmpeg(), { path: '/nonexistent/ffmpeg', version: null, encoders: [] })
  assert.equal(tools.serverConversion(), false)
  assert.deepEqual(tools.detectedEncoders(), [])
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
