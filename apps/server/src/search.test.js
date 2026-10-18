import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSearch } from './search.js'
import { createSources } from './sources/index.js'
import { SourceError, release } from './sources/release.js'
import { fakeSource, fixture, mockFetch, never } from './sources/test-helpers.js'

const SAMPLE_HASH = 'd797d14fb859b0f4f70e6081080ff28135830522'
const r = (fields, source) => release({ title: 'Some.Show.S01.720p.x264', ...fields }, source)

test('merges duplicates across sources: best seeders, all source names', async () => {
  const searcher = createSearch([
    fakeSource('bitmagnet', async () => [r({ infoHash: SAMPLE_HASH, seeders: null, size: 828725915 }, 'bitmagnet')]),
    fakeSource('Jackett', async () => [r({ infoHash: SAMPLE_HASH, seeders: 50 }, 'Jackett'), r({ infoHash: 'a'.repeat(40), seeders: 99 }, 'Jackett')]),
  ])
  const { results, sources } = await searcher.search('x')
  assert.equal(results.length, 2)
  assert.equal(results[0].seeders, 99) // sorted by seeders
  const sample = results.find(x => x.infoHash === SAMPLE_HASH)
  assert.equal(sample.seeders, 50)
  assert.equal(sample.size, 828725915)
  assert.deepEqual(sample.sources, ['bitmagnet', 'Jackett'])
  assert.deepEqual(sources.map(s => [s.name, s.ok, s.count]), [['bitmagnet', true, 1], ['Jackett', true, 2]])
})

test('one failing and one hanging source still return the others, with reasons', async t => {
  // AbortSignal.timeout is unref'ed. Unlike a real socket, the mock alone does
  // not keep Node 22's event loop alive long enough for its timeout to fire.
  const keepAlive = setInterval(() => {}, 1000)
  t.after(() => clearInterval(keepAlive))
  const searcher = createSearch([
    fakeSource('good', async () => [r({ infoHash: SAMPLE_HASH }, 'good')]),
    fakeSource('broken', async () => { throw new SourceError('HTTP 500') }),
    fakeSource('slow', (q, { signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason)))),
  ], { timeoutMs: 50 })
  const { results, sources } = await searcher.search('x')
  assert.equal(results.length, 1)
  assert.deepEqual(sources.map(s => [s.name, s.ok, s.error ?? null]), [
    ['good', true, null],
    ['broken', false, 'HTTP 500'],
    ['slow', false, 'timed out after 0.05 s'],
  ])
})

test('no configured source is a readable 503, not an empty 502', async () => {
  await assert.rejects(createSearch([]).search('x'), err => err.status === 503 && /No search sources/.test(err.message))
})

test('all sources failing is a 502 naming each', async () => {
  const searcher = createSearch([
    fakeSource('a', async () => { throw new SourceError('HTTP 401: check the API key') }),
    fakeSource('b', async () => { throw new SourceError("can't reach b") }),
  ])
  await assert.rejects(searcher.search('x'), err => err.status === 502 && /a: HTTP 401.*b: can't reach b/.test(err.message))
})

test('link-only duplicates merge by title and size', async () => {
  const searcher = createSearch([
    fakeSource('a', async () => [r({ title: 'Movie.2010.720p', size: 700, link: 'http://a/dl/1' }, 'a'), r({ title: 'Other', link: 'http://a/dl/2' }, 'a')]),
    fakeSource('b', async () => [r({ title: 'movie.2010.720p', size: 700, link: 'http://b/dl/9' }, 'b'), r({ title: 'Other', link: 'http://b/dl/3' }, 'b')]),
    fakeSource('c', async () => [r({ title: 'Movie.2010.720p', size: 700, infoHash: SAMPLE_HASH }, 'c')]),
  ])
  const { results } = await searcher.search('x')
  const movie = results.filter(x => /movie/i.test(x.title))
  assert.equal(movie.length, 2) // the infohash one is keyed differently; the two link-only ones merged
  const linkOnly = movie.find(x => x.sources.length === 2)
  assert.deepEqual(linkOnly.sources, ['a', 'b'])
  assert.equal(results.filter(x => x.title === 'Other').length, 2) // no size: can't tell, keep both
})

test('download links stay on the server; the browser gets an id', async () => {
  const link = 'http://prowlarr:9696/7/download?apikey=SECRETKEY&link=cHJp'
  const searcher = createSearch([fakeSource('p', async () => [r({ link }, 'p')])])
  const { results } = await searcher.search('x')
  assert.equal(results[0].link, undefined)
  assert.doesNotMatch(JSON.stringify(results), /SECRETKEY/)
  assert.equal(searcher.linkFor(results[0].linkId), link)
  assert.equal(searcher.linkFor('unknown'), null)
})

test('end to end with mocked BitMagnet, Jackett and Prowlarr over HTTP', async t => {
  const keepAlive = setInterval(() => {}, 1000)
  t.after(() => clearInterval(keepAlive))
  const fetch = mockFetch(url => {
    if (url.host === 'bitmagnet:3333') return { body: fixture('bitmagnet.xml') }
    if (url.host === 'jackett:9117') return { body: fixture('jackett.xml') }
    if (url.host === 'prowlarr:9696') return { body: fixture('prowlarr-search.json') }
    if (url.host === 'down:1') return never()
  })
  const searcher = createSearch(createSources([
    { type: 'torznab', name: 'bitmagnet', url: 'http://bitmagnet:3333/torznab/api' },
    { type: 'jackett', name: 'Jackett', url: 'http://jackett:9117', apiKey: 'jk' },
    { type: 'prowlarr', name: 'Prowlarr', url: 'http://prowlarr:9696', apiKey: 'pk' },
    { type: 'torznab', name: 'down', url: 'http://down:1/api' },
  ], { fetch }), { timeoutMs: 100 })
  const { results, sources } = await searcher.search('Big Buck Bunny S01')

  assert.deepEqual(sources.map(s => [s.name, s.ok, s.count ?? s.error]), [
    ['bitmagnet', true, 3], ['Jackett', true, 3], ['Prowlarr', true, 2], ['down', false, 'timed out after 0.1 s'],
  ])
  // The OpenContent pack is in all three; private releases with only proxy links stay separate per source
  const sample = results.filter(x => x.infoHash === SAMPLE_HASH)
  assert.equal(sample.length, 1)
  assert.deepEqual(sample[0].sources, ['bitmagnet', 'Jackett/Public Tracker', 'Prowlarr/ExampleIndexer'])
  assert.equal(sample[0].seeders, 61)
  // The private release is link-only in both Jackett and Prowlarr: matched by title and size
  const priv = results.filter(x => x.title.includes('WEB-DL'))
  assert.equal(priv.length, 1)
  assert.deepEqual(priv[0].sources, ['Jackett/Private Tracker', 'Prowlarr/PrivateTracker'])
  assert.equal(results.length, 3 + 3 + 2 - 2 - 1)
  assert.equal(fetch.calls.find(c => c.url.host === 'jackett:9117').url.pathname, '/api/v2.0/indexers/all/results/torznab/api')
})
