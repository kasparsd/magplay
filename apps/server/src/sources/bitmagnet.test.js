import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createBitmagnetBrowser, groupTitles } from './bitmagnet.js'
import { SourceError } from './release.js'
import { fixture, mockFetch } from './test-helpers.js'

const explore = JSON.parse(fixture('bitmagnet-explore.json'))
const items = explore.data.torrentContent.search.items

test('groups releases into titles, skipping unmatched and adult ones', () => {
  const titles = groupTitles(items)
  const matched = new Set(items.filter(i => i.content && !i.content.adult).map(i => `${i.content.source}:${i.content.id}`))
  assert.equal(titles.length, matched.size)
  assert.ok(!titles.some(t => t.title === 'Adult Title'))
  const bunny = titles.find(t => t.title === 'Big Buck Bunny')
  assert.equal('releaseCount' in bunny, false) // a page holds only some releases, so no count is claimed
  assert.equal(bunny.source, 'tmdb')
  assert.ok(bunny.genres.length > 0)
  assert.ok(bunny.links.some(l => l.source === 'imdb'))
  // The best release plays in a browser when any does, otherwise it's the most seeded
  const releases = items.filter(i => i.content?.title === 'Big Buck Bunny')
  assert.ok(releases.some(r => r.infoHash === bunny.best))
  assert.equal(bunny.seeders, Math.max(...releases.map(r => r.seeders)))
})

test('browse sends type, filters and sort, without the slow counts', async () => {
  const fetch = mockFetch(() => ({ body: JSON.stringify(explore) }))
  const browser = createBitmagnetBrowser({ url: 'http://bitmagnet:3333/torznab/api' }, { fetch })
  const out = await browser.browse({ type: 'tv_show', genre: 'tmdb:35', year: 2024, resolution: 'V1080p', sort: 'added', page: 2 })
  const { url, opts } = fetch.calls[0]
  assert.equal(url.href, 'http://bitmagnet:3333/graphql')
  const { input } = JSON.parse(opts.body).variables
  assert.deepEqual(input.facets.contentType, { filter: ['tv_show'] })
  assert.deepEqual(input.facets.genre, { filter: ['tmdb:35'] })
  assert.deepEqual(input.facets.releaseYear, { filter: ['2024'] }) // BitMagnet's Year is a string
  assert.deepEqual(input.facets.videoResolution, { filter: ['V1080p'] })
  assert.deepEqual(input.orderBy, [{ field: 'published_at', descending: true }])
  assert.equal(input.page, 2)
  assert.doesNotMatch(JSON.parse(opts.body).query, /aggregations/)
  assert.ok(out.titles.length > 0)
  assert.equal(input.hasNextPage, true) // asked for, so "Show more" knows when to stop
})

test('facets aggregate under the current filters, from BitMagnet\'s cache, sorted for display', async () => {
  const fetch = mockFetch(() => ({ body: JSON.stringify(explore) }))
  const f = await createBitmagnetBrowser({ url: 'http://bitmagnet:3333' }, { fetch }).facets({ type: 'movie', genre: 'tmdb:35' })
  const { query, variables: { input } } = JSON.parse(fetch.calls[0].opts.body)
  assert.match(query, /aggregations/)
  assert.equal(input.cached, true)
  const { facets } = input
  assert.deepEqual(facets.genre, { filter: ['tmdb:35'], aggregate: true })
  assert.deepEqual(facets.releaseYear, { aggregate: true })
  assert.ok(f.genres[0].label && f.genres[0].count >= f.genres.at(-1).count)
  assert.ok(f.years[0].value >= f.years.at(-1).value)
})

test('facets mark counts BitMagnet only estimated', async () => {
  const aggregations = { genre: [{ value: 'tmdb:18', label: 'Drama', count: 675, isEstimate: true }, { value: 'tmdb:35', label: 'Comedy', count: 59785, isEstimate: false }], releaseYear: [], videoResolution: [] }
  const fetch = mockFetch(() => ({ body: JSON.stringify({ data: { torrentContent: { search: { aggregations } } } }) }))
  const f = await createBitmagnetBrowser({ url: 'http://bitmagnet:3333' }, { fetch }).facets({ type: 'movie' })
  assert.deepEqual(f.genres, [{ value: 'tmdb:35', label: 'Comedy', count: 59785 }, { value: 'tmdb:18', label: 'Drama', count: 675, estimate: true }])
})

test('title says when the search had more hits than it read', async () => {
  const bunny = items.find(i => i.content?.title === 'Big Buck Bunny')
  const fetch = mockFetch(() => ({ body: JSON.stringify({ data: { torrentContent: { search: { hasNextPage: true, items: [bunny] } } } }) }))
  const t = await createBitmagnetBrowser({ url: 'http://bitmagnet:3333' }, { fetch }).title({ type: 'movie', source: bunny.content.source, id: bunny.content.id, title: 'Big Buck Bunny' })
  assert.equal(t.truncated, true)
})

test('latest keeps unmatched releases but hides adult ones', async () => {
  const fetch = mockFetch(() => ({ body: fixture('bitmagnet-latest.json') }))
  const latest = await createBitmagnetBrowser({ url: 'http://bitmagnet:3333' }, { fetch }).latest({ type: 'tv_show' })
  assert.equal(latest.length, 6)
  assert.ok(latest[0].episode)
  assert.ok(latest.every(r => r.infoHash && r.name))
  const withAdult = mockFetch(() => ({ body: JSON.stringify(explore) }))
  const mixed = await createBitmagnetBrowser({ url: 'http://bitmagnet:3333' }, { fetch: withAdult }).latest()
  assert.ok(mixed.some(r => r.title === null)) // unmatched stay
  assert.ok(!mixed.some(r => r.title?.title === 'Adult Title'))
})

test('title keeps only releases of that exact title', async () => {
  const fetch = mockFetch(() => ({ body: JSON.stringify(explore) }))
  const bunny = items.find(i => i.content?.title === 'Big Buck Bunny').content
  const browser = createBitmagnetBrowser({ url: 'http://bitmagnet:3333' }, { fetch })
  const t = await browser.title({ type: 'movie', source: bunny.source, id: bunny.id, title: bunny.title, year: bunny.releaseYear })
  assert.equal(t.title, 'Big Buck Bunny')
  assert.equal(t.releases.length, 1)
  assert.equal(t.truncated, false)
  assert.equal(JSON.parse(fetch.calls[0].opts.body).variables.input.hasNextPage, true)
  assert.equal(JSON.parse(fetch.calls[0].opts.body).variables.input.queryString, `Big Buck Bunny ${bunny.releaseYear}`)
  assert.equal(await browser.title({ type: 'movie', source: 'tmdb', id: '0', title: 'Nothing' }), null)
})

test('GraphQL errors become readable source errors', async () => {
  const fetch = mockFetch(() => ({ body: JSON.stringify({ errors: [{ message: 'unknown field' }] }) }))
  await assert.rejects(createBitmagnetBrowser({ url: 'http://bitmagnet:3333' }, { fetch }).browse(), err => err instanceof SourceError && /BitMagnet: unknown field/.test(err.message))
})
