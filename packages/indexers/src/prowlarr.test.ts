import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createProwlarrSource, parseProwlarrResults } from './prowlarr.ts'
import type { ProwlarrOptions } from './prowlarr.ts'
import { SourceError } from './errors.ts'
import { fixture, mockFetch } from './test-helpers.ts'
import type { MockFetch } from './test-helpers.ts'

const prowlarr = (fetch: MockFetch, opts: Partial<ProwlarrOptions> = {}) =>
  createProwlarrSource({ name: 'Prowlarr', url: 'http://prowlarr:9696', apiKey: 'k2', ...opts }, { fetch })
const signal = () => AbortSignal.timeout(1000)

test('searches all torrent indexers through /api/v1/search with the key in a header', async () => {
  const fetch = mockFetch(() => ({ body: fixture('prowlarr-search.json'), headers: { 'content-type': 'application/json' } }))
  await prowlarr(fetch).search('Big Buck Bunny S01', { cat: '5000', signal: signal() })
  const { url, opts } = fetch.calls[0]!
  assert.equal(url.pathname, '/api/v1/search')
  assert.equal(url.searchParams.get('query'), 'Big Buck Bunny S01')
  assert.equal(url.searchParams.get('type'), 'search')
  assert.deepEqual(url.searchParams.getAll('indexerIds'), ['-2'])
  assert.deepEqual(url.searchParams.getAll('categories'), ['5000'])
  assert.equal(url.searchParams.get('apikey'), null) // not in the URL
  assert.equal(opts.headers?.['X-Api-Key'], 'k2')
})

test('keeps a base path and specific indexer ids', async () => {
  const fetch = mockFetch(() => ({ body: '[]' }))
  await prowlarr(fetch, { url: 'http://media-server/prowlarr/', indexerIds: ['3', '7'] }).search('x', { signal: signal() })
  assert.equal(fetch.calls[0]?.url.pathname, '/prowlarr/api/v1/search')
  assert.deepEqual(fetch.calls[0]?.url.searchParams.getAll('indexerIds'), ['3', '7'])
})

test('maps releases: infohash beats proxied links, proxy link otherwise, usenet and broken items dropped', () => {
  const results = parseProwlarrResults(JSON.parse(fixture('prowlarr-search.json')), 'Prowlarr')
  assert.equal(results.length, 2)
  const [sample, privateTracker] = results as [typeof results[0], typeof results[0]]
  assert.equal(sample.infoHash, 'd797d14fb859b0f4f70e6081080ff28135830522')
  assert.match(sample.magnet!, /^magnet:\?xt=urn:btih:d797d14f/) // built from the infohash, no proxy hop
  assert.equal(sample.link, null)
  assert.equal(sample.seeders, 61)
  assert.deepEqual(sample.sources, ['Prowlarr/ExampleIndexer'])

  assert.equal(privateTracker.magnet, null)
  assert.match(privateTracker.link!, /^http:\/\/prowlarr:9696\/7\/download\?/)
  assert.deepEqual(privateTracker.sources, ['Prowlarr/PrivateTracker'])
})

test('a body that is not a list, or holds junk, is no results', () => {
  for (const body of [null, {}, 'x', [null, 1, 'x', { protocol: 'torrent' }]]) assert.deepEqual(parseProwlarrResults(body, 'P'), [])
})

test('a bad API key is reported as such, and a broken body as a source error', async () => {
  const source = prowlarr(mockFetch(() => ({ status: 401, body: '' })))
  await assert.rejects(source.search('x', { signal: signal() }), err => err instanceof SourceError && /check the API key/.test(err.message))
  const broken = prowlarr(mockFetch(() => ({ body: '<html>' })))
  await assert.rejects(broken.search('x', { signal: signal() }), err => err instanceof SourceError && /Prowlarr returned invalid JSON/.test(err.message))
})
