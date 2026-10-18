import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStatus } from './status.ts'
import type { CheckResult } from './status.ts'

function clock () {
  let now = 1_000_000
  return { now: () => now, advance: (ms: number) => { now += ms } }
}

test('checks are cached per TTL, so polling doesn’t rerun them', async () => {
  const time = clock()
  const status = createStatus({ now: time.now })
  let runs = 0
  status.registerCheck({ id: 'a', label: 'A', ttl: 60_000, required: true, run: () => { runs++; return { level: 'ok', value: `${runs}` } } })
  assert.equal((await status.snapshot()).checks[0]?.value, '1')
  time.advance(30_000)
  assert.equal((await status.snapshot()).checks[0]?.value, '1')
  time.advance(30_000)
  assert.equal((await status.snapshot()).checks[0]?.value, '2')
  status.invalidate('a')
  assert.equal((await status.snapshot()).checks[0]?.value, '3')
})

test('a throwing check is an error with its message; a null result is hidden', async () => {
  const status = createStatus({ now: clock().now })
  status.registerCheck({ id: 'boom', label: 'Boom', ttl: 0, run: () => { throw new Error('refused the API key') } })
  status.registerCheck({ id: 'quiet', label: 'Quiet', ttl: 0, run: () => null })
  const { checks, level } = await status.snapshot()
  assert.deepEqual(checks.map(c => [c.id, c.level, c.message]), [['boom', 'error', 'refused the API key']])
  assert.equal(level, 'error')
})

test('the overall level is unknown until required checks have run, and slow checks report unknown', async () => {
  const status = createStatus({ now: clock().now })
  let finish: (r: CheckResult) => void = () => {}
  status.registerCheck({ id: 'slow', label: 'Slow', ttl: 60_000, required: true, run: () => new Promise<CheckResult>(resolve => { finish = resolve }) })
  status.registerCheck({ id: 'fast', label: 'Fast', ttl: 60_000, run: () => ({ level: 'ok' }) })
  const first = await status.snapshot({ wait: 10 })
  assert.equal(first.level, 'unknown')
  assert.equal(first.checks.find(c => c.id === 'slow')?.level, 'unknown')
  finish({ level: 'ok' })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal((await status.snapshot()).level, 'ok')
})

test('a result from before invalidate() is dropped, so a slow run can’t overwrite a newer one', async () => {
  const status = createStatus({ now: clock().now })
  const finishers: Array<(r: CheckResult) => void> = []
  status.registerCheck({ id: 'a', label: 'A', ttl: 60_000, run: () => new Promise<CheckResult>(resolve => { finishers.push(resolve) }) })
  await status.snapshot({ wait: 0 })
  status.invalidate('a')
  await status.snapshot({ wait: 0 })
  finishers[1]?.({ level: 'ok', value: 'new' })
  finishers[0]?.({ level: 'error', value: 'old' })
  await new Promise(resolve => setImmediate(resolve))
  const { checks } = await status.snapshot({ wait: 0 })
  assert.deepEqual(checks.map(c => [c.level, c.value]), [['ok', 'new']])
})
