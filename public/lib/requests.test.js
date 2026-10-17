import { test } from 'node:test'
import assert from 'node:assert/strict'
import { latestRequest, serialLatest, delay } from './requests.js'

test('request-owned delay clears its timer and preserves the abort reason', async t => {
  const clear = t.mock.method(globalThis, 'clearTimeout')
  const controller = new AbortController()
  const result = delay(50, controller.signal)
  const error = new Error('page closed')
  controller.abort(error)
  await assert.rejects(result, err => err === error)
  assert.equal(clear.mock.callCount(), 1)
})

test('resolved delay removes its abort listener and pre-aborted delays reject', async t => {
  const controller = new AbortController()
  await delay(1, controller.signal)
  const clear = t.mock.method(globalThis, 'clearTimeout')
  controller.abort()
  assert.equal(clear.mock.callCount(), 0)
  await assert.rejects(delay(50, controller.signal), err => err === controller.signal.reason)
})

const deferred = () => {
  let resolve
  const promise = new Promise(r => { resolve = r })
  return { promise, resolve }
}

test('only the newest request may update the UI', () => {
  const begin = latestRequest()
  const first = begin()
  assert.equal(first(), true)
  const second = begin()
  assert.equal(first(), false)
  assert.equal(second(), true)
})

test('playback mutations are serialized and superseded queued work is skipped', async () => {
  const run = serialLatest()
  const gate = deferred()
  const calls = []
  const first = run(async current => {
    calls.push('first')
    await gate.promise
    assert.equal(current(), false)
    return 'stale'
  })
  await Promise.resolve()
  const second = run(() => { calls.push('second') })
  const third = run(() => { calls.push('third'); return 'latest' })
  assert.deepEqual(calls, ['first'])
  gate.resolve()
  assert.equal(await first, 'stale')
  assert.equal(await second, undefined)
  assert.equal(await third, 'latest')
  assert.deepEqual(calls, ['first', 'third'])
})

test('failed playback requests do not block the next one', async () => {
  const run = serialLatest()
  await assert.rejects(run(() => { throw new Error('offline') }), /offline/)
  assert.equal(await run(() => 'recovered'), 'recovered')
})
