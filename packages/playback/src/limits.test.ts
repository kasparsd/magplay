import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createLimiter } from './limits.ts'
import { PlaybackBusyError } from './errors.ts'

const busy = () => new PlaybackBusyError('Media probing is busy. Try again shortly.')

function deferred<T = void> () {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>(_resolve => { resolve = _resolve })
  return { promise, resolve }
}

test('expensive work is bounded with fail-fast busy errors, not queued', async () => {
  const run = createLimiter(1, busy)
  const gate = deferred<string>()
  const first = run(() => gate.promise)
  let invoked = false
  await assert.rejects(run(() => { invoked = true }), PlaybackBusyError)
  assert.equal(invoked, false)
  gate.resolve('done')
  assert.equal(await first, 'done')
  assert.equal(await run(() => 'next'), 'next')
})

test('sync throws and async failures release slots', async () => {
  const run = createLimiter(1, busy)
  await assert.rejects(run(() => { throw new Error('spawn failed') }), /spawn failed/)
  await assert.rejects(run(() => Promise.reject(new Error('conversion failed'))), /conversion failed/)
  assert.equal(await run(() => 'recovered'), 'recovered')
})

test('a limit given as a function follows a changed setting, and stats report busy slots', async () => {
  let limit = 1
  const run = createLimiter(() => limit, busy)
  const gate = deferred()
  const first = run(() => gate.promise)
  assert.deepEqual(run.stats(), { used: 1, limit: 1 })
  limit = 2
  assert.equal(await run(() => 'second'), 'second')
  gate.resolve()
  await first
  assert.deepEqual(run.stats(), { used: 0, limit: 2 })
})
