import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { HttpError } from './errors.ts'
import { apiRoutes } from './routes.ts'
import type { RouteDeps } from './routes.ts'

// The guard runs before the handler touches any service, so the services can be missing
const routes = apiRoutes({} as RouteDeps)
const writes = routes.filter(r => r.methods.split('|').some(method => method !== 'GET' && method !== 'HEAD'))
const call = (handler: (typeof routes)[number]['handler'], headers: IncomingMessage['headers']) => () =>
  handler({ req: { headers } as IncomingMessage, res: {} as ServerResponse, params: {}, query: new URLSearchParams() })

test('every API write refuses browser requests from pages on other sites', () => {
  assert.ok(writes.length >= 7, 'settings, test, clear-hls, torrents, play, tab and session')
  for (const { methods, pattern, handler } of writes) {
    for (const headers of [{ 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'same-site' }, { origin: 'http://evil.example', host: 'magplay:8080' }]) {
      assert.throws(call(handler, headers), (err: unknown) => err instanceof HttpError && err.status === 403, `${methods} ${pattern} ${JSON.stringify(headers)}`)
    }
  }
})

test('API writes from this site and from clients that aren’t browsers reach their handler', () => {
  for (const { methods, pattern, handler } of writes) {
    for (const headers of [{ 'sec-fetch-site': 'same-origin' }, { origin: 'http://magplay:8080', host: 'magplay:8080' }, {}]) {
      // Past the guard, the missing services fail with something other than the guard's 403
      try {
        const result = call(handler, headers)()
        if (result instanceof Promise) result.catch(() => {})
      } catch (err) {
        assert.ok(!(err instanceof HttpError && err.status === 403), `${methods} ${pattern}`)
      }
    }
  }
})

test('reads are not guarded', () => {
  const reads = routes.filter(r => !writes.includes(r))
  assert.ok(reads.some(r => r.pattern === '/raw/:ih/:idx/:name?'))
  for (const { pattern, handler } of reads) {
    try {
      const result = call(handler, { 'sec-fetch-site': 'cross-site' })()
      if (result instanceof Promise) result.catch(() => {})
    } catch (err) {
      assert.ok(!(err instanceof HttpError && err.status === 403), pattern)
    }
  }
})
