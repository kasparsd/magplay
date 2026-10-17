import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createProwlarrSource } from './prowlarr.js'
import { SourceError } from './release.js'
import { fixture, mockFetch } from './test-helpers.js'

const prowlarr = (fetch, opts = {}) =>
  createProwlarrSource({ name: 'Prowlarr', url: 'http://prowlarr:9696', apiKey: 'k2', ...opts }, { fetch })

test('searches all torrent indexers through /api/v1/search with the key in a header', async () => {
  const fetch = mockFetch(() => ({ body: fixture('prowlarr-search.json'), headers: { 'content-type': 'application/json' } }))
  await prowlarr(fetch).search('Big Buck Bunny S01', { cat: '5000' })
  const { url, opts } = fetch.calls[0]
  assert.equal(url.pathname, '/api/v1/search')
  assert.equal(url.searchParams.get('query'), 'Big Buck Bunny S01')
  assert.equal(url.searchParams.get('type'), 'search')
  assert.deepEqual(url.searchParams.getAll('indexerIds'), ['-2'])
  assert.deepEqual(url.searchParams.getAll('categories'), ['5000'])
  assert.equal(url.searchParams.get('apikey'), null) // not in the URL
  assert.equal(opts.headers['X-Api-Key'], 'k2')
})

test('keeps a base path and specific indexer ids', async () => {
  const fetch = mockFetch(() => ({ body: '[]' }))
  await prowlarr(fetch, { url: 'http://media-server/prowlarr/', indexerIds: ['3', '7'] }).search('x')
  assert.equal(fetch.calls[0].url.pathname, '/prowlarr/api/v1/search')
  assert.deepEqual(fetch.calls[0].url.searchParams.getAll('indexerIds'), ['3', '7'])
})

test('maps releases: infohash beats proxied links, proxy link otherwise, usenet and broken items dropped', async () => {
  const results = await prowlarr(mockFetch(() => ({ body: fixture('prowlarr-search.json') }))).search('Big Buck Bunny')
  assert.equal(results.length, 2)
  const [sample, privateTracker] = results
  assert.equal(sample.infoHash, 'd797d14fb859b0f4f70e6081080ff28135830522')
  assert.match(sample.magnet, /^magnet:\?xt=urn:btih:d797d14f/) // built from the infohash, no proxy hop
  assert.equal(sample.link, null)
  assert.equal(sample.seeders, 61)
  assert.deepEqual(sample.sources, ['Prowlarr/ExampleIndexer'])

  assert.equal(privateTracker.magnet, null)
  assert.match(privateTracker.link, /^http:\/\/prowlarr:9696\/7\/download\?/)
  assert.deepEqual(privateTracker.sources, ['Prowlarr/PrivateTracker'])
})

test('a bad API key is reported as such', async () => {
  const source = prowlarr(mockFetch(() => ({ status: 401, body: '' })))
  await assert.rejects(source.search('x'), err => err instanceof SourceError && /check the API key/.test(err.message))
})
