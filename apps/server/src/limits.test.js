import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createLimiter } from './limits.js'

function deferred () {
  let resolve
  const promise = new Promise(_resolve => { resolve = _resolve })
  return { promise, resolve }
}

test('expensive work is bounded with fail-fast retryable overload, not queued', async () => {
  const run = createLimiter(1, 'Probing')
  const gate = deferred()
  const first = run(() => gate.promise)
  let invoked = false
  await assert.rejects(run(() => { invoked = true }), { status: 503, retryAfter: 5 })
  assert.equal(invoked, false)
  gate.resolve('done')
  assert.equal(await first, 'done')
  assert.equal(await run(() => 'next'), 'next')
})

test('sync throws and async failures release expensive-work slots', async () => {
  const run = createLimiter(1, 'Subtitles')
  await assert.rejects(run(() => { throw new Error('spawn failed') }), /spawn failed/)
  await assert.rejects(run(async () => { throw new Error('conversion failed') }), /conversion failed/)
  assert.equal(await run(() => 'recovered'), 'recovered')
})
