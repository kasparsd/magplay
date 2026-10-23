import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHlsSessions } from '@magplay/playback'
import type { FfmpegProcess, HlsSessions } from '@magplay/playback'
import { createTabs } from './tabs.ts'
import { HttpError } from '../http/errors.ts'

const fakeProcess = (): FfmpegProcess => {
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  return Object.assign(new EventEmitter(), { pid: 1, stdout, stderr, stdio: [null, stdout, stderr, new PassThrough()], kill: () => true }) as unknown as FfmpegProcess
}
const options = { input: 'http://127.0.0.1/raw/x/0', info: { duration: 60, startTime: 0, audio: [], subtitles: [] }, audio: 0, start: 0, mode: 'remux' as const, keyframes: [0, 6, 12] }

async function setup (t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'magplay-tabs-'))
  // The sessions call back into the tabs, so the tabs read them lazily
  const tabs = createTabs(() => hls)
  const hls: HlsSessions = createHlsSessions({ dir: path.join(dir, 'hls'), spawnProcess: fakeProcess, onStop: tabs.forget })
  t.after(async () => {
    await hls.close()
    await fs.rm(dir, { recursive: true, force: true })
  })
  return { hls, tabs }
}

test('a tab owns one session: starting another replaces it, even at capacity', async t => {
  const { hls, tabs } = await setup(t)
  const first = tabs.start('one', options)
  const other = tabs.start('two', options)
  const replacement = tabs.start('one', options)
  assert.equal(hls.get(first.id), undefined)
  assert.equal(hls.get(other.id), other)
  tabs.stop('one')
  assert.equal(hls.get(replacement.id), undefined)
  tabs.stop('unknown')
})

test('closing a tab fences late playback requests without blocking a fresh activation', async t => {
  const { hls, tabs } = await setup(t)
  const first = tabs.start('closing', options)
  tabs.close('closing')
  assert.equal(hls.get(first.id), undefined)
  assert.throws(() => tabs.start('closing', options), (err: unknown) => err instanceof HttpError && err.status === 409)
  const next = tabs.start('reactivated', options)
  assert.equal(hls.get(next.id), next)
  assert.throws(() => tabs.close('x'.repeat(65)), (err: unknown) => err instanceof HttpError && err.status === 400)
})
