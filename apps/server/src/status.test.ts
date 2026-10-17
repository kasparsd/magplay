import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStatus, EVENT_LIMIT } from './status.ts'
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

test('level changes become events; a first ok is not news; the buffer is capped', async () => {
  const time = clock()
  const status = createStatus({ now: time.now })
  let level: CheckResult['level'] = 'ok'
  status.registerCheck({ id: 'p', label: 'Prowlarr', ttl: 0, run: () => ({ level, message: 'refused the API key' }) })
  await status.snapshot()
  assert.deepEqual(status.events(), [])
  level = 'error'
  await status.snapshot()
  level = 'ok'
  await status.snapshot()
  assert.deepEqual(status.events().map(e => [e.level, e.message]), [['error', 'Prowlarr: refused the API key'], ['ok', 'Prowlarr is working again']])
  for (let i = 0; i < EVENT_LIMIT + 5; i++) status.pushEvent({ checkId: 'settings', level: 'ok', message: `Saved ${i}` })
  assert.equal(status.events().length, EVENT_LIMIT)
  assert.equal(status.events().at(-1)?.message, `Saved ${EVENT_LIMIT + 4}`)
})
