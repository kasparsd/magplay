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
