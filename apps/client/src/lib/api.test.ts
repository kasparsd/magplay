/* eslint-disable @typescript-eslint/require-await -- fetch mocks are async functions to match fetch's signature */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { api, ApiError } from './api.ts'
import type { ApiOptions } from './api.ts'

/** The init a mocked fetch was called with. */
const initOf = (call: { arguments: unknown[] } | undefined): RequestInit & { headers: Headers } => {
  assert.ok(call)
  return call.arguments[1] as RequestInit & { headers: Headers }
}

// Importing the transport above must not require a browser or load ui.js.
test('API client imports without a DOM', () => {
  assert.equal(typeof document, 'undefined')
  assert.equal(typeof api, 'function')
})

test('GET forwards the URL/options without adding retry, cache or origin defaults', async t => {
  const signal = new AbortController().signal
  const headers = { Accept: 'application/json' }
  const options: RequestInit = { signal, headers, cache: 'reload', credentials: 'same-origin', redirect: 'error' }
  const fetch = t.mock.method(globalThis, 'fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(url, '/api/torrents/abc/status?idx=0')
    assert.deepEqual(init, options)
    assert.equal(init?.signal, signal)
    assert.equal(init?.headers, headers)
    return Response.json({ loaded: false, session: null })
  })
  assert.deepEqual(await api('/api/torrents/abc/status?idx=0', options), { loaded: false, session: null })
  assert.equal(fetch.mock.callCount(), 1)
  assert.deepEqual(options, { signal, headers, cache: 'reload', credentials: 'same-origin', redirect: 'error' })
})

test('plain GET and default JSON POST retain the existing calling convention', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json({ ok: true }))
  await api('/health')
  assert.deepEqual(fetch.mock.calls[0]?.arguments, ['/health', {}])
  const payload = { ih: 'abc', idx: 0, audio: 1, start: 30, caps: { h264: true } }
  await api('/api/play', { json: payload })
  const options = initOf(fetch.mock.calls[1])
  assert.equal(fetch.mock.calls[1]?.arguments[0], '/api/play')
  assert.equal(options.method, 'POST')
  assert.equal(options.headers.get('Content-Type'), 'application/json')
  assert.deepEqual(JSON.parse(options.body as string), payload)
})

test('JSON requests merge all supported header forms without mutating options', async t => {
  const forms: HeadersInit[] = [
    { Accept: 'application/json', 'content-type': 'text/plain' },
    [['Accept', 'application/json'], ['content-type', 'text/plain']],
    new Headers({ Accept: 'application/json', 'content-type': 'text/plain' }),
  ]
  for (const headers of forms) {
    const original = [...new Headers(headers)]
    const signal = new AbortController().signal
    const options: ApiOptions = { json: null, method: 'PUT', headers, body: 'overridden', signal, cache: 'no-store' }
    const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json({ ok: true }))
    await api('/api/example', options)
    const sent = initOf(fetch.mock.calls[0])
    assert.equal(sent.method, 'PUT')
    assert.equal(sent.body, 'null')
    assert.equal(sent.signal, signal)
    assert.equal(sent.cache, 'no-store')
    assert.equal(sent.headers.get('Accept'), 'application/json')
    assert.equal(sent.headers.get('Content-Type'), 'application/json')
    assert.deepEqual([...new Headers(headers)], original)
    assert.equal(options.body, 'overridden')
    assert.equal(options.headers, headers)
    fetch.mock.restore()
  }
})

test('non-JSON request bodies and explicit methods are passed through untouched', async t => {
  const headers = new Headers({ 'Content-Type': 'text/plain' })
  const options: RequestInit = { method: 'DELETE', body: 'raw body', headers }
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json({ ok: true }))
  await api('/api/play/session', options)
  assert.deepEqual(initOf(fetch.mock.calls[0]), options)
  assert.equal(initOf(fetch.mock.calls[0]).headers, headers)
})

test('successful arrays, primitives and null are returned without shape coercion', async t => {
  for (const value of [[{ idx: 0 }], null, 'value', 0, false]) {
    const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json(value))
    assert.deepEqual(await api('/api/example'), value)
    fetch.mock.restore()
  }
})

test('HTTP errors retain the server message and status used by the refusal UI', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ error: 'Open in an external player' }, { status: 422 }))
  await assert.rejects(api('/api/play'), { message: 'Open in an external player', status: 422 })
})

test('proxy HTML, malformed JSON and missing/non-string errors use a safe HTTP fallback', async t => {
  for (const body of ['<html>Bad gateway</html>', '{', '', 'null', '[]', '"message"', '{"error":null}', '{"error":42}', '{"error":""}']) {
    const fetch = t.mock.method(globalThis, 'fetch', async () => new Response(body, { status: 502 }))
    await assert.rejects(api('/api/example'), { message: 'HTTP 502', status: 502 }, body)
    fetch.mock.restore()
  }
})

test('malformed/empty successful JSON is reported instead of masquerading as an empty object', async t => {
  for (const body of ['<html>Proxy login</html>', '{', '']) {
    const fetch = t.mock.method(globalThis, 'fetch', async () => new Response(body, { status: 200 }))
    await assert.rejects(api('/api/example'), err => {
      assert.ok(err instanceof ApiError)
      assert.equal(err.message, 'Invalid JSON response')
      assert.equal(err.status, 200)
      assert.ok(err.cause instanceof SyntaxError)
      return true
    })
    fetch.mock.restore()
  }
})

test('network errors pass through unchanged and requests are never implicitly retried', async t => {
  const error = new TypeError('Failed to fetch')
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw error })
  await assert.rejects(api('/api/play', { json: { idx: 0 } }), err => err === error)
  assert.equal('status' in error, false)
  assert.equal(fetch.mock.callCount(), 1)
})

test('an already-aborted signal preserves its native reason', async t => {
  const controller = new AbortController()
  controller.abort()
  t.mock.method(globalThis, 'fetch', async (_url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    assert.equal(init?.signal, controller.signal)
    controller.signal.throwIfAborted()
    return Response.json(null)
  })
  await assert.rejects(api('/api/example', { signal: controller.signal }), err => err === controller.signal.reason)
})

test('abort during a response-body read is not swallowed as invalid JSON or an HTTP failure', async t => {
  for (const status of [200, 502]) {
    for (const reason of [new DOMException('Cancelled', 'AbortError'), new SyntaxError('Custom abort reason')]) {
      const controller = new AbortController()
      const stream = new ReadableStream({
        start (body) { controller.signal.addEventListener('abort', () => body.error(controller.signal.reason), { once: true }) },
      })
      const fetch = t.mock.method(globalThis, 'fetch', async () => new Response(stream, { status }))
      const result = api('/api/example', { signal: controller.signal })
      const rejected = assert.rejects(result, err => err === reason)
      await new Promise(resolve => setImmediate(resolve)) // headers received, body still pending
      controller.abort(reason)
      await rejected
      fetch.mock.restore()
    }
  }
})

test('response stream failures preserve their cause even for an HTTP error response', async t => {
  const error = new TypeError('Connection lost while reading the body')
  const stream = new ReadableStream({ start (body) { body.error(error) } })
  t.mock.method(globalThis, 'fetch', async () => new Response(stream, { status: 503 }))
  await assert.rejects(api('/api/example'), err => err === error)
})
