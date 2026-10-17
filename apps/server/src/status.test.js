import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createStatus } from './status.js'

const config = {
  ffmpegPath: 'ffmpeg',
  ffprobePath: 'ffprobe',
  cacheDir: '/cache',
  minFreeBytes: 1024,
  sources: [],
  bitmagnetUrl: null,
}

test('status checks are cached by TTL and level changes enter the recent event ring', async () => {
  let now = 0
  let level = 'ok'
  let calls = 0
  const status = createStatus({
    config,
    now: () => now,
    exec: async () => ({ stdout: 'ffmpeg version test\n' }),
    statfsImpl: async () => ({ bavail: 100, bsize: 1024 }),
  })
  status.registerCheck({ id: 'custom', label: 'Custom', ttl: 100, required: false, run: () => ({ level, value: 'test', calls: ++calls }) })

  await status.snapshot()
  await status.snapshot()
  assert.equal(calls, 1)

  now = 101
  level = 'error'
  const next = await status.snapshot()
  assert.equal(calls, 2)
  assert.equal(next.checks.find(check => check.id === 'custom')?.level, 'error')
  assert.deepEqual(next.events[0], { at: 101, checkId: 'custom', level: 'error', message: 'test' })
})
