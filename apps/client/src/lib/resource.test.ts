import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createCache, memoryStore, poll, takeLatest } from './resource.ts'
import type { PollHost } from './resource.ts'

const deferred = <T>(): { promise: Promise<T>, resolve: (v: T) => void } => {
  let resolve = (_: T): void => {}
  const promise = new Promise<T>(_resolve => { resolve = _resolve })
  return { promise, resolve }
}

test('a newer request aborts the previous one', () => {
  const begin = takeLatest()
  const first = begin()
  const second = begin()
  assert.equal(first.aborted, true)
  assert.equal(second.aborted, false)
})

test('the parent lifetime aborts the current request', () => {
  const page = new AbortController()
  const signal = takeLatest(page.signal)()
  page.abort()
  assert.equal(signal.aborted, true)
})

test('callers share one in-flight load and fresh values skip the server', async () => {
  let clock = 0
  const cache = createCache(memoryStore(), () => clock)
  let loads = 0
  const gate = deferred<string>()
  const load = (): Promise<string> => { loads++; return gate.promise }
  const a = cache.get('k', load, { staleMs: 1000 })
  const b = cache.get('k', load, { staleMs: 1000 })
  gate.resolve('v')
  assert.deepEqual(await Promise.all([a, b]), ['v', 'v'])
  clock = 500
  assert.equal(await cache.get('k', () => Promise.resolve('new'), { staleMs: 1000 }), 'v')
  clock = 1500
  assert.equal(await cache.get('k', () => Promise.resolve('new'), { staleMs: 1000 }), 'new')
  assert.equal(loads, 1)
})

test('peek returns stale values and invalidate forgets a prefix', async () => {
  const cache = createCache()
  await cache.get('search:a', () => Promise.resolve(1))
  await cache.get('status', () => Promise.resolve(2))
  assert.equal(cache.peek('search:a'), 1)
  cache.invalidate('search:')
  assert.equal(cache.peek('search:a'), undefined)
  assert.equal(cache.peek('status'), 2)
})

test('one caller leaving does not cancel the shared load', async () => {
  const cache = createCache()
  const gate = deferred<string>()
  const leaving = new AbortController()
  const a = cache.get('k', () => gate.promise, { signal: leaving.signal })
  const b = cache.get('k', () => Promise.resolve('other'))
  leaving.abort(new Error('left'))
  await assert.rejects(a, /left/)
  gate.resolve('v')
  assert.equal(await b, 'v')
})

function fakeHost (): PollHost & { hidden: () => boolean, setHidden: (h: boolean) => void, tick: () => void, pending: () => number } {
  let hidden = false
  let visible = (): void => {}
  let timers: Array<() => void> = []
  return {
    hidden: () => hidden,
    setHidden: h => { hidden = h; if (!h) visible() },
    onVisible: listener => { visible = listener },
    setTimeout: fn => { timers.push(fn); return fn },
    clearTimeout: id => { timers = timers.filter(t => t !== id) },
    tick: () => { const due = timers; timers = []; for (const fn of due) fn() },
    pending: () => timers.length,
  }
}

const settle = (): Promise<void> => new Promise(resolve => setImmediate(resolve))

test('polls now and after each run, skips hidden tabs and catches up when visible', async () => {
  const host = fakeHost()
  let runs = 0
  poll(() => { runs++; return Promise.resolve() }, { everyMs: 1000, host })
  assert.equal(runs, 1)
  await settle()
  host.tick()
  assert.equal(runs, 2)
  await settle()
  host.setHidden(true)
  host.tick()
  assert.equal(runs, 2)
  host.setHidden(false)
  assert.equal(runs, 3)
})

test('never runs twice at once and stops with its signal', async () => {
  const host = fakeHost()
  const gate = deferred<void>()
  const stop = new AbortController()
  let runs = 0
  const poller = poll(() => { runs++; return gate.promise }, { everyMs: 1000, host, signal: stop.signal })
  poller.now()
  assert.equal(runs, 1)
  gate.resolve()
  await settle()
  stop.abort()
  host.tick()
  assert.equal(runs, 1)
  assert.equal(host.pending(), 0)
})

test('a false condition skips runs without stopping', async () => {
  const host = fakeHost()
  let onScreen = false
  let runs = 0
  poll(() => { runs++; return Promise.resolve() }, { everyMs: 1000, host, when: () => onScreen })
  assert.equal(runs, 0)
  onScreen = true
  host.tick()
  assert.equal(runs, 1)
  await settle()
})
