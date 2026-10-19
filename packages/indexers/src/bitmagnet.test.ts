import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createBitmagnetBrowser, groupTitles, parseSearchResponse } from './bitmagnet.ts'
import { SearchTimeout, SourceError } from './errors.ts'
import { fixture, mockFetch, never } from './test-helpers.ts'

interface RawItem { infoHash: string, seeders: number, content?: { source: string, id: string, title: string, adult?: boolean, releaseYear?: number } }

const explore = JSON.parse(fixture('bitmagnet-explore.json')) as { data: { torrentContent: { search: { items: RawItem[] } } } }
const rawItems = explore.data.torrentContent.search.items
const { items } = parseSearchResponse(explore)
const body = (opts: { body?: string } | undefined) => JSON.parse(opts?.body ?? '{}') as { query: string, variables: { input: Record<string, unknown> & { facets: Record<string, unknown> } } }
const bm = (fetch: ReturnType<typeof mockFetch>, url = 'http://bitmagnet:3333') => createBitmagnetBrowser({ url }, { fetch })

test('parses every item, keeping unmatched ones without content', () => {
  assert.equal(items.length, rawItems.length)
  assert.ok(items.some(i => i.content === null))
  assert.throws(() => parseSearchResponse({ data: {} }), err => err instanceof SourceError && /unexpected answer/.test(err.message))
  assert.deepEqual(parseSearchResponse({ data: { torrentContent: { search: { items: [null, { seeders: 3 }] } } } }).items, [])
})

test('groups releases into titles, skipping unmatched and adult ones', () => {
  const titles = groupTitles(items)
  const matched = new Set(rawItems.filter(i => i.content && !i.content.adult).map(i => `${i.content!.source}:${i.content!.id}`))
  assert.equal(titles.length, matched.size)
  assert.ok(!titles.some(t => t.title === 'Adult Title'))
  const bunny = titles.find(t => t.title === 'Big Buck Bunny')!
  assert.equal('releaseCount' in bunny, false) // a page holds only some releases, so no count is claimed
  assert.equal(bunny.source, 'tmdb')
  assert.ok(bunny.genres.length > 0)
  assert.ok(bunny.links.some(l => l.source === 'imdb'))
  // The best release has the lowest title-estimated effort, then the most seeders
  const direct = { ...items.find(i => i.content && !i.content.adult)!, infoHash: 'direct', seeders: 4, torrent: { name: 'Film.1080p.H264.AAC', size: 1 } }
  const remuxLow = { ...direct, infoHash: 'remux-low', seeders: 20, torrent: { name: 'Film.1080p.H264.DDP5.1', size: 1 } }
  const remuxHigh = { ...remuxLow, infoHash: 'remux-high', seeders: 30 }
  const ranked = groupTitles([remuxLow, direct, remuxHigh])
  assert.equal(ranked[0]?.best, 'direct')
  assert.equal(groupTitles([remuxLow, remuxHigh])[0]?.best, 'remux-high')
  const releases = rawItems.filter(i => i.content?.title === 'Big Buck Bunny')
  assert.equal(bunny.seeders, Math.max(...releases.map(r => r.seeders)))
})

test('browse sends type, filters and sort, without the slow counts', async () => {
  const fetch = mockFetch(() => ({ body: JSON.stringify(explore) }))
  const out = await bm(fetch, 'http://bitmagnet:3333/torznab/api').browse({ type: 'tv_show', genre: 'tmdb:35', year: 2024, resolution: 'V1080p', sort: 'added', page: 2 })
  const { url, opts } = fetch.calls[0]!
  assert.equal(url.href, 'http://bitmagnet:3333/graphql')
  const { query, variables: { input } } = body(opts)
  assert.deepEqual(input.facets.contentType, { filter: ['tv_show'] })
  assert.deepEqual(input.facets.genre, { filter: ['tmdb:35'] })
  assert.deepEqual(input.facets.releaseYear, { filter: ['2024'] }) // BitMagnet's Year is a string
  assert.deepEqual(input.facets.videoResolution, { filter: ['V1080p'] })
  assert.deepEqual(input.orderBy, [{ field: 'published_at', descending: true }])
  assert.equal(input.page, 2)
  assert.doesNotMatch(query, /aggregations/)
  assert.ok(out.titles.length > 0)
  assert.equal(input.hasNextPage, true) // asked for, so "Show more" knows when to stop
})

test('facets aggregate under the current filters, from BitMagnet\'s cache, sorted for display', async () => {
  const fetch = mockFetch(() => ({ body: JSON.stringify(explore) }))
  const f = await bm(fetch).facets({ type: 'movie', genre: 'tmdb:35' })
  const { query, variables: { input } } = body(fetch.calls[0]?.opts)
  assert.match(query, /aggregations/)
  assert.equal(input.cached, true)
  const { facets } = input
  assert.deepEqual(facets.genre, { filter: ['tmdb:35'], aggregate: true })
  assert.deepEqual(facets.releaseYear, { aggregate: true })
  assert.ok(f.genres[0]?.label && f.genres[0].count >= f.genres.at(-1)!.count)
  assert.ok(Number(f.years[0]?.value) >= Number(f.years.at(-1)?.value))
})

test('facets mark counts BitMagnet only estimated', async () => {
  const aggregations = { genre: [{ value: 'tmdb:18', label: 'Drama', count: 675, isEstimate: true }, { value: 'tmdb:35', label: 'Comedy', count: 59785, isEstimate: false }], releaseYear: [], videoResolution: [] }
  const fetch = mockFetch(() => ({ body: JSON.stringify({ data: { torrentContent: { search: { aggregations } } } }) }))
  const f = await bm(fetch).facets({ type: 'movie' })
  assert.deepEqual(f.genres, [{ value: 'tmdb:35', label: 'Comedy', count: 59785 }, { value: 'tmdb:18', label: 'Drama', count: 675, estimate: true }])
})

test('title says when the search had more hits than it read', async () => {
  const bunny = rawItems.find(i => i.content?.title === 'Big Buck Bunny')!
  const fetch = mockFetch(() => ({ body: JSON.stringify({ data: { torrentContent: { search: { hasNextPage: true, items: [bunny] } } } }) }))
  const t = await bm(fetch).title({ type: 'movie', source: bunny.content!.source, id: bunny.content!.id, title: 'Big Buck Bunny' })
  assert.equal(t?.truncated, true)
})

test('latest keeps unmatched releases but hides adult ones', async () => {
  const fetch = mockFetch(() => ({ body: fixture('bitmagnet-latest.json') }))
  const latest = await bm(fetch).latest({ type: 'tv_show' })
  assert.equal(latest.length, 6)
  assert.ok(latest[0]?.episode)
  assert.ok(latest.every(r => r.infoHash && r.name))
  const mixed = await bm(mockFetch(() => ({ body: JSON.stringify(explore) }))).latest()
  assert.ok(mixed.some(r => r.title === null)) // unmatched stay
  assert.ok(!mixed.some(r => r.title?.title === 'Adult Title'))
})

test('title keeps only releases of that exact title', async () => {
  const fetch = mockFetch(() => ({ body: JSON.stringify(explore) }))
  const bunny = rawItems.find(i => i.content?.title === 'Big Buck Bunny')!.content!
  const browser = bm(fetch)
  const t = await browser.title({ type: 'movie', source: bunny.source, id: bunny.id, title: bunny.title, year: bunny.releaseYear ?? null })
  assert.equal(t?.title, 'Big Buck Bunny')
  assert.equal(t.releases.length, 1)
  assert.equal(t.truncated, false)
  const { input } = body(fetch.calls[0]?.opts).variables
  assert.equal(input.hasNextPage, true)
  assert.equal(input.queryString, `Big Buck Bunny ${bunny.releaseYear}`)
  assert.equal(await browser.title({ type: 'movie', source: 'tmdb', id: '0', title: 'Nothing' }), null)
})

test('GraphQL errors become readable source errors', async () => {
  const fetch = mockFetch(() => ({ body: JSON.stringify({ errors: [{ message: 'unknown field' }] }) }))
  await assert.rejects(bm(fetch).browse(), err => err instanceof SourceError && /BitMagnet: unknown field/.test(err.message))
})

test('a timed-out request is a SearchTimeout; the status check keeps the raw timeout', async t => {
  const keepAlive = setInterval(() => {}, 1000)
  t.after(() => clearInterval(keepAlive))
  const browser = bm(mockFetch(never))
  await assert.rejects(browser.browse({}, { signal: AbortSignal.timeout(10) }), err => err instanceof SearchTimeout && /took too long/.test(err.message))
  await assert.rejects(browser.check({ signal: AbortSignal.timeout(10) }), { name: 'TimeoutError' })
})
