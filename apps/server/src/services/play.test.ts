import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import { createPlay } from './play.ts'
import type { PlayOptions } from './play.ts'
import type { MediaInfo } from '@magplay/playback'

const info: MediaInfo = { container: 'mp4', isWebm: false, duration: 90, video: { codec: 'h264', tag: '', bitDepth: 8, profile: null, width: 320, height: 180, sampleAspect: 1 }, audio: [], subtitles: [] }

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
    policy: () => ({ allowTranscode: false, transcodeMaxHeight: 720 }),
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
    policy: () => ({ allowTranscode: false, transcodeMaxHeight: 720 }),
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
    media: { probe: () => Promise.resolve(info) },
    tabs: { stop: () => {}, start: () => ({ id: 's' }) },
    policy: () => ({ allowTranscode: false, transcodeMaxHeight: 720 }),
    input: () => 'http://raw',
  } as unknown as PlayOptions
  const play = createPlay(options)
  const result = await play.play({ ih: 'ih', idx: 0, caps: { h264: true } }, () => false)
  assert.equal(result.mode, 'remux')
})

test('a remux reports the keyframe it starts on, not the later requested time', async () => {
  const mkv: MediaInfo = { ...info, container: 'matroska,webm', audio: [{ index: 0, codec: 'aac', channels: 2, language: null, title: null, default: true }] }
  let started = -1
  const options = {
    engine: { get: () => Promise.resolve({ files: [{ name: 'a.mkv' }] }), file: () => Promise.resolve({ name: 'a.mkv' }), describe: () => ({ files: [] }) },
    media: { probe: () => Promise.resolve(mkv), keyframeBefore: (_input: string, at: number) => { assert.equal(at, 35.2); return Promise.resolve(34) } },
    tabs: { stop: () => {}, start: (_tab: string, opts: { start: number }) => { started = opts.start; return { id: 's' } } },
    policy: () => ({ allowTranscode: false, transcodeMaxHeight: 720 }),
    input: () => 'http://raw',
  } as unknown as PlayOptions
  const result = await createPlay(options).play({ ih: 'ih', idx: 0, start: 35.2, caps: { h264: true, aac: true } }, () => false)
  assert.equal(result.mode, 'remux')
  assert.equal(result.offset, 34)
  assert.equal(started, 34)
})

test('a transcode keeps the requested time instead of snapping to a keyframe', async () => {
  const mpeg4: MediaInfo = { ...info, video: { ...info.video!, codec: 'mpeg4' } }
  let started = -1
  const options = {
    engine: { get: () => Promise.resolve({ files: [{ name: 'a.mkv' }] }), file: () => Promise.resolve({ name: 'a.mkv' }), describe: () => ({ files: [] }) },
    media: { probe: () => Promise.resolve(mpeg4), keyframeBefore: () => Promise.reject(new Error('must not look up a keyframe')) },
    tabs: { stop: () => {}, start: (_tab: string, opts: { start: number }) => { started = opts.start; return { id: 's' } } },
    policy: () => ({ allowTranscode: true, transcodeMaxHeight: 720 }),
    input: () => 'http://raw',
  } as unknown as PlayOptions
  const result = await createPlay(options).play({ ih: 'ih', idx: 0, start: 35.2, caps: { aac: true } }, () => false)
  assert.equal(result.mode, 'transcode')
  assert.equal(result.offset, 35.2)
  assert.equal(started, 35.2)
})

test('faststart MP4 is still played directly', async () => {
  const files = [faststartFile()]
  const options = {
    engine: { get: () => Promise.resolve({ files }), file: () => Promise.resolve(files[0]), describe: () => ({ files: [] }) },
    media: { probe: () => Promise.resolve(info) },
    tabs: { stop: () => {}, start: () => ({ id: 's' }) },
    policy: () => ({ allowTranscode: false, transcodeMaxHeight: 720 }),
    input: () => 'http://raw',
  } as unknown as PlayOptions
  const play = createPlay(options)
  const result = await play.play({ ih: 'ih', idx: 0, caps: { h264: true } }, () => false)
  assert.equal(result.mode, 'direct')
})
