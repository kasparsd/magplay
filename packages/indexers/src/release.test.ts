import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SourceError } from './errors.ts'
import { readJson, readText, request } from './release.ts'
import { mockFetch } from './test-helpers.ts'

const redirect = (location: string): { status: number, headers: Record<string, string> } => ({ status: 302, headers: { location } })

test('redirects are followed on the same server, keeping the request options', async () => {
  const fetch = mockFetch(url => url.pathname === '/old' ? redirect('/new?apikey=k') : { body: 'ok' })
  const res = await request(fetch, 'http://jackett:9117/old', { headers: { 'X-Api-Key': 'k' } })
  assert.equal(await res.text(), 'ok')
  assert.deepEqual(fetch.calls.map(c => c.url.href), ['http://jackett:9117/old', 'http://jackett:9117/new?apikey=k'])
  assert.equal(fetch.calls[1]?.opts.headers?.['X-Api-Key'], 'k')
  assert.equal(fetch.calls[1]?.opts.redirect, 'manual')
})

test('an http → https upgrade on the same host is followed', async () => {
  const fetch = mockFetch(url => url.protocol === 'http:' ? redirect('https://prowlarr.lan/api') : { body: 'ok' })
  assert.equal(await (await request(fetch, 'http://prowlarr.lan/api', {})).text(), 'ok')
})

test('a redirect to another server is refused, so credentials never leave', async () => {
  const fetch = mockFetch(() => redirect('https://elsewhere.example/api'))
  await assert.rejects(request(fetch, 'http://jackett:9117/api?apikey=k', { headers: { 'X-Api-Key': 'k' } }),
    (err: unknown) => err instanceof SourceError && /another server \(elsewhere\.example\)/.test(err.message))
  assert.equal(fetch.calls.length, 1)
})

test('redirect loops stop with a SourceError', async () => {
  const fetch = mockFetch(() => redirect('/again'))
  await assert.rejects(request(fetch, 'http://h/start', {}), /too many redirects/)
  assert.equal(fetch.calls.length, 4)
})

test('bodies past the limit are refused, by Content-Length or while streaming', async () => {
  const declared = new Response('x', { headers: { 'content-length': String(64 * 1024 ** 2) } })
  await assert.rejects(readText(declared, 'Jackett'), (err: unknown) => err instanceof SourceError && /Jackett sent 64 MB/.test(err.message))
  const chunk = new Uint8Array(1024).fill(97)
  const stream = new ReadableStream<Uint8Array>({
    pull (controller) { controller.enqueue(chunk) }, // never ends
  })
  await assert.rejects(readText(new Response(stream), 'Prowlarr', 10 * 1024), /Prowlarr sent more than/)
})

test('readJson names the source for bodies that are not JSON', async () => {
  assert.deepEqual(await readJson(new Response('{"a":1}'), 'BitMagnet'), { a: 1 })
  await assert.rejects(readJson(new Response('<html>'), 'BitMagnet'), /BitMagnet returned invalid JSON/)
})
