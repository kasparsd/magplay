import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import { createPlay } from './play.ts'
import type { PlayOptions } from './play.ts'
import type { MediaInfo } from '@magplay/playback'

const info: MediaInfo = { container: 'mp4', isWebm: false, duration: 90, startTime: 0, video: { codec: 'h264', tag: '', bitDepth: 8, profile: null, width: 320, height: 180, sampleAspect: 1 }, audio: [], subtitles: [] }

function deferred () {
  let finish!: (value: MediaInfo) => void
  let fail!: (error: Error) => void
  const promise = new Promise<MediaInfo>((resolve, reject) => { finish = resolve; fail = reject })
  return { promise, resolve: finish, reject: fail }
}

function setup () {
  const files = [{ name: 'sample.mp4' }]
  const probes: Array<ReturnType<typeof deferred>> = []
  const options = {
    engine: { get: () => Promise.resolve({ files }), file: () => Promise.resolve(files[0]), describe: () => ({ files: [] }) },
    media: { probe: () => { const job = deferred(); probes.push(job); return job.promise } },
    tabs: { stop: () => {} },
    policy: () => ({ serverConversion: true, allowTranscode: false, transcodeMaxHeight: 720 }),
    input: () => 'http://raw',
  } as unknown as PlayOptions
  return { play: createPlay(options), probes }
}

test('preparation counts overlapping probe and play callers and clears after success', async () => {
  const { play, probes } = setup()
  const first = play.probe('ih', 0)
  const second = play.play({ ih: 'ih', idx: 0, caps: { h264: true } }, () => false)
  assert.equal(play.preparation('ih', 0), 'loading-file')
  await setImmediate()
  assert.equal(play.preparation('ih', 0), 'probing')
  assert.equal(play.preparation('other', 0), null)
  probes[0]!.resolve(info)
  await first
  assert.equal(play.preparation('ih', 0), 'probing')
  probes[1]!.resolve(info)
  assert.equal((await second).mode, 'direct')
  assert.equal(play.preparation('ih', 0), null)
})

test('failed probing removes its phase and permits a later successful retry', async () => {
  const { play, probes } = setup()
  const failed = play.probe('ih', 0)
  const rejection = assert.rejects(failed, /probe failed/)
  await setImmediate()
  probes[0]!.reject(new Error('probe failed'))
  await rejection
  assert.equal(play.preparation('ih', 0), null)
  const retry = play.probe('ih', 0)
  await setImmediate()
  assert.equal(play.preparation('ih', 0), 'probing')
  probes[1]!.resolve(info)
  await retry
  assert.equal(play.preparation('ih', 0), null)
})

test('cancelled preparation has one metric outcome and no false error or session', async () => {
  const { createLogging, createMetrics } = await import('@magplay/observability')
  const logging = createLogging({ level: 'debug', sink: { write () {} } })
  const telemetry = createMetrics({ runtime: false })
  const options = {
    engine: {},
    media: {},
    tabs: { start: () => { throw new Error('must not start') } },
    policy: () => ({ serverConversion: true, allowTranscode: false, transcodeMaxHeight: 720 }),
    input: () => '',
    logger: logging.logger,
    metrics: telemetry.metrics,
  } as unknown as PlayOptions
  const play = createPlay(options)
  await assert.rejects(play.play({ ih: 'hash', idx: 0 }, () => true, { logger: logging.logger.child({ requestId: 'request' }) }), /cancelled/)
  assert.match(await telemetry.registry.metrics(), /magplay_playback_attempts_total\{mode="unknown",outcome="cancelled"\} 1/)
  assert.equal(logging.tail().filter(l => l.level === 'error' || l.level === 'warn').length, 0)
  assert.ok(logging.tail().some(l => l.requestId === 'request' && typeof l.operationId === 'string'))
  telemetry.close()
})

function faststartFile () {
  return {
    name: 'sample.mp4',
    read: async function * () {
      await Promise.resolve()
      // moov box before mdat box: faststart.
      const bytes = new Uint8Array(124)
      const view = new DataView(bytes.buffer)
      view.setUint32(0, 24); bytes.set([0x6d, 0x6f, 0x6f, 0x76], 4)
      view.setUint32(24, 100); bytes.set([0x6d, 0x64, 0x61, 0x74], 28)
      yield bytes
    },
  }
}

function nonFaststartFile () {
  return {
    name: 'sample.mp4',
    read: async function * () {
      await Promise.resolve()
      // ftyp box (24 bytes) followed by mdat box (100 bytes): moov is not before mdat.
      const bytes = new Uint8Array(124)
      const view = new DataView(bytes.buffer)
      view.setUint32(0, 24); bytes.set([0x66, 0x74, 0x79, 0x70], 4)
      view.setUint32(24, 100); bytes.set([0x6d, 0x64, 0x61, 0x74], 28)
      yield bytes
    },
  }
}

test('non-faststart MP4 is remuxed instead of played directly', async () => {
  const files = [nonFaststartFile()]
  const options = {
    engine: { get: () => Promise.resolve({ files }), file: () => Promise.resolve(files[0]), describe: () => ({ files: [] }) },
    media: { probe: () => Promise.resolve(info), keyframes: () => Promise.resolve(null) },
    tabs: { stop: () => {}, start: () => ({ id: 's', growing: true }) },
    policy: () => ({ serverConversion: true, allowTranscode: false, transcodeMaxHeight: 720 }),
    input: () => 'http://raw',
  } as unknown as PlayOptions
  const play = createPlay(options)
  const result = await play.play({ ih: 'ih', idx: 0, caps: { h264: true } }, () => false)
  assert.equal(result.mode, 'remux')
})

test('a remux plays the whole file from a session cut on the file\'s keyframes, starting conversion at the request', async () => {
  const mkv: MediaInfo = { ...info, container: 'matroska', audio: [{ index: 0, codec: 'aac', channels: 2, language: null, title: null, default: true }] }
  let started: { start: number, keyframes: number[] | null } | null = null
  const options = {
    engine: { get: () => Promise.resolve({ files: [{ name: 'a.mkv' }] }), file: () => Promise.resolve({ name: 'a.mkv', length: 1000 }), describe: () => ({ files: [] }) },
    media: { probe: () => Promise.resolve(mkv), keyframes: (_input: string, size: number) => { assert.equal(size, 1000); return Promise.resolve([0, 6, 12]) } },
    tabs: { stop: () => {}, start: (_tab: string, opts: { start: number, keyframes: number[] | null }) => { started = opts; return { id: 's', growing: false } } },
    policy: () => ({ serverConversion: true, allowTranscode: false, transcodeMaxHeight: 720 }),
    input: () => 'http://raw',
  } as unknown as PlayOptions
  const result = await createPlay(options).play({ ih: 'ih', idx: 0, start: 35.2, caps: { h264: true, aac: true } }, () => false)
  assert.equal(result.mode, 'remux')
  assert.equal('offset' in result, false)
  assert.equal(result.mode === 'remux' && result.growing, false)
  assert.deepEqual(started, { ...started!, start: 35.2, keyframes: [0, 6, 12] })
})

test('a transcode starts converting at the requested time and needs no keyframe index', async () => {
  const mpeg4: MediaInfo = { ...info, video: { ...info.video!, codec: 'mpeg4' } }
  let started = -1
  const options = {
    engine: { get: () => Promise.resolve({ files: [{ name: 'a.mkv' }] }), file: () => Promise.resolve({ name: 'a.mkv' }), describe: () => ({ files: [] }) },
    media: { probe: () => Promise.resolve(mpeg4), keyframes: () => Promise.reject(new Error('a transcode cuts its own segments')) },
    tabs: { stop: () => {}, start: (_tab: string, opts: { start: number }) => { started = opts.start; return { id: 's', growing: false } } },
    policy: () => ({ serverConversion: true, allowTranscode: true, transcodeMaxHeight: 720 }),
    input: () => 'http://raw',
  } as unknown as PlayOptions
  const result = await createPlay(options).play({ ih: 'ih', idx: 0, start: 35.2, caps: { aac: true } }, () => false)
  assert.equal(result.mode, 'transcode')
  assert.equal(started, 35.2)
})

test('faststart MP4 is still played directly', async () => {
  const files = [faststartFile()]
  const options = {
    engine: { get: () => Promise.resolve({ files }), file: () => Promise.resolve(files[0]), describe: () => ({ files: [] }) },
    media: { probe: () => Promise.resolve(info) },
    tabs: { stop: () => {}, start: () => ({ id: 's' }) },
    policy: () => ({ serverConversion: true, allowTranscode: false, transcodeMaxHeight: 720 }),
    input: () => 'http://raw',
  } as unknown as PlayOptions
  const play = createPlay(options)
  const result = await play.play({ ih: 'ih', idx: 0, caps: { h264: true } }, () => false)
  assert.equal(result.mode, 'direct')
})

test('without ffmpeg an MKV is repackaged in the browser: no session, the whole-file timeline and the audio track', async () => {
  const mkv: MediaInfo = { ...info, container: 'matroska', audio: [{ index: 0, codec: 'ac3', channels: 6, language: null, title: null, default: true }, { index: 1, codec: 'aac', channels: 2, language: null, title: null, default: false }] }
  const options = {
    engine: { get: () => Promise.resolve({ files: [{ name: 'a.mkv' }] }), file: () => Promise.resolve({ name: 'a.mkv' }), describe: () => ({ files: [] }) },
    media: { probe: () => Promise.resolve(mkv), keyframes: () => Promise.reject(new Error('the browser finds its own keyframes')) },
    tabs: { stop: () => {}, start: () => { throw new Error('no server session without ffmpeg') } },
    policy: () => ({ serverConversion: false, allowTranscode: true, transcodeMaxHeight: 720 }),
    input: () => 'http://raw',
  } as unknown as PlayOptions
  const result = await createPlay(options).play({ ih: 'ih', idx: 0, start: 35.2, audio: 1, caps: { h264: true, aac: true } }, () => false)
  assert.equal(result.mode, 'browser-remux')
  assert.equal(result.url, '/raw/ih/0')
  assert.equal(result.audio, 1)
  assert.equal(result.session, undefined)
})

test('without ffmpeg a browser that cannot repackage gets an HLS session produced in Node', async () => {
  const mkv: MediaInfo = { ...info, container: 'matroska', audio: [{ index: 0, codec: 'ac3', channels: 6, language: null, title: null, default: true }] }
  let started = ''
  const options = {
    engine: { get: () => Promise.resolve({ files: [{ name: 'a.mkv' }] }), file: () => Promise.resolve({ name: 'a.mkv' }), describe: () => ({ files: [] }) },
    media: { probe: () => Promise.resolve(mkv), keyframes: () => Promise.resolve([0, 6, 12]) },
    tabs: { stop: () => {}, start: (_tab: string, opts: { mode: string }) => { started = opts.mode; return { id: 's', growing: false } } },
    policy: () => ({ serverConversion: false, allowTranscode: true, transcodeMaxHeight: 720 }),
    input: () => 'http://raw',
  } as unknown as PlayOptions
  const result = await createPlay(options).play({ ih: 'ih', idx: 0, start: 12, caps: { h264: true }, browserRemux: false }, () => false)
  assert.equal(started, 'node-remux')
  assert.equal(result.mode, 'remux')
  assert.equal(result.session, 's')
  assert.deepEqual(result.subtitles, [])
})
