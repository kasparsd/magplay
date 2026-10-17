import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTorznabSource, parseFeed } from './torznab.js'
import { SourceError } from './release.js'
import { fixture, mockFetch } from './test-helpers.js'

const SAMPLE_HASH = 'd797d14fb859b0f4f70e6081080ff28135830522'

test('BitMagnet: real feed, infohash as guid, missing seeders kept as null', () => {
  const results = parseFeed(fixture('bitmagnet.xml'), 'bitmagnet')
  assert.equal(results.length, 3)
  const sample = results.find(r => r.infoHash === SAMPLE_HASH)
  assert.equal(sample.title, 'Big Buck Bunny.S01.COMPLETE.720p.BluRay.x264-OpenContent')
  assert.match(sample.magnet, /^magnet:\?xt=urn:btih:d797d14f/)
  assert.equal(sample.link, null)
  assert.ok(sample.size > 800e6)
  assert.deepEqual(sample.sources, ['bitmagnet'])
  const noSeeders = results.find(r => r.title.includes('2160p'))
  assert.equal(noSeeders.seeders, null)
  assert.ok(noSeeders.magnet)
})

test('Jackett: raw magnet from magneturl, /dl/ proxy only when there is no magnet, tracker page guid ignored', () => {
  const results = parseFeed(fixture('jackett.xml'), 'Jackett')
  assert.equal(results.length, 3)
  const [publicTracker, privateTracker, magnetOnly] = results
  assert.equal(publicTracker.infoHash, SAMPLE_HASH) // upper-case infohash normalized
  assert.match(publicTracker.magnet, /^magnet:/)
  assert.equal(publicTracker.link, null)
  assert.equal(publicTracker.seeders, 50)
  assert.equal(publicTracker.size, 828725915) // from <size>, not a torznab attr

  assert.equal(privateTracker.infoHash, null)
  assert.equal(privateTracker.magnet, null)
  assert.match(privateTracker.link, /^http:\/\/jackett:9117\/dl\/privatetracker\//)

  assert.deepEqual(results.map(r => r.sources[0]), ['Jackett/Public Tracker', 'Jackett/Private Tracker', 'Jackett/Magnet Site'])
  assert.equal(magnetOnly.infoHash, '2222222222222222222222222222222222222222')
  assert.equal(magnetOnly.seeders, null)
})

test('numeric titles stay strings and items without a title or any link are dropped', () => {
  const xml = `<rss><channel>
    <item><title>1917</title><guid isPermaLink="false">fedcba9876543210fedcba9876543210fedcba98</guid></item>
    <item><guid>no title</guid></item>
    <item><title>No links at all</title><guid>https://example/details/1</guid></item>
  </channel></rss>`
  const results = parseFeed(xml, 'x')
  assert.equal(results.length, 1)
  assert.equal(results[0].title, '1917')
  assert.equal(results[0].infoHash, 'fedcba9876543210fedcba9876543210fedcba98')
})

test('request: free-text t=search with limit, category and API key', async () => {
  const fetch = mockFetch(() => ({ body: fixture('bitmagnet.xml') }))
  const source = createTorznabSource({ name: 'bm', url: 'http://bitmagnet:3333/torznab/api', apiKey: 'k1' }, { fetch })
  await source.search('Big Buck Bunny S01', { cat: '5000' })
  const { url } = fetch.calls[0]
  assert.equal(url.pathname, '/torznab/api')
  assert.equal(url.searchParams.get('t'), 'search')
  assert.equal(url.searchParams.get('q'), 'Big Buck Bunny S01')
  assert.equal(url.searchParams.get('limit'), '100')
  assert.equal(url.searchParams.get('cat'), '5000')
  assert.equal(url.searchParams.get('apikey'), 'k1')
  assert.equal(url.searchParams.get('season'), null) // season/ep filters hide packs
})

test('errors: Torznab <error>, HTTP status, unreachable host, non-feed body', async () => {
  const cases = [
    [() => ({ status: 400, body: '<?xml version="1.0"?><error code="100" description="Invalid API Key" />' }), /Invalid API Key/],
    [() => ({ status: 401, body: 'Unauthorized' }), /HTTP 401: check the API key/],
    [() => ({ status: 500, body: 'boom' }), /^HTTP 500$/],
    [() => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }) }, /can't reach jackett:9117 \(ECONNREFUSED\)/],
    [() => ({ body: '<html>login page</html>' }), /not a Torznab feed/],
  ]
  for (const [handler, message] of cases) {
    const source = createTorznabSource({ name: 'j', url: 'http://jackett:9117/api/v2.0/indexers/all/results/torznab/api' }, { fetch: mockFetch(handler) })
    await assert.rejects(source.search('x'), err => err instanceof SourceError && message.test(err.message))
  }
})
