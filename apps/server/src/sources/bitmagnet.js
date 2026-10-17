// BitMagnet's GraphQL API, for browsing: it classifies torrents against TMDB, so it can filter by type, genre, year and
// resolution and return titles with metadata. Search still goes through Torznab (torznab.js).
import { badges } from '@magplay/release-info'
import { request, SourceError } from './release.js'

const ITEM_FIELDS = `infoHash contentType seeders publishedAt videoResolution episodes { label } torrent { name size }
  content { type source id title releaseYear voteAverage runtime overview adult collections { type name } externalLinks { metadataSource { key } url } }`

const SEARCH = `query($input: TorrentContentSearchQueryInput!) { torrentContent { search(input: $input) {
  hasNextPage items { ${ITEM_FIELDS} } } } }`

// Counts are slow on a big index (tens of seconds for TV), so they're a separate, cacheable query
const FACETS = `query($input: TorrentContentSearchQueryInput!) { torrentContent { search(input: $input) {
  aggregations { genre { value label count } releaseYear { value count } videoResolution { value count } } } } }`

export const TYPES = ['movie', 'tv_show']

/** A release as the pages show it, with the same title badges as search results. */
export function toRelease (item) {
  const name = item.torrent?.name || item.content?.title || item.infoHash
  return {
    infoHash: item.infoHash,
    name,
    size: item.torrent?.size ?? null,
    seeders: item.seeders ?? null,
    episode: item.episodes?.label ?? null,
    publishedAt: item.publishedAt ?? null,
    ...badges(name),
  }
}

/** What the pages need to know about a film or show. */
export function toTitle (content) {
  return {
    type: content.type,
    source: content.source,
    id: content.id,
    title: content.title,
    year: content.releaseYear ?? null,
    rating: content.voteAverage ? Math.round(content.voteAverage * 10) / 10 : null,
    runtime: content.runtime ?? null,
    overview: content.overview ?? null,
    genres: (content.collections ?? []).filter(c => c.type === 'genre').map(c => c.name),
    links: (content.externalLinks ?? []).map(l => ({ source: l.metadataSource?.key, url: l.url })).filter(l => l.source && l.url),
  }
}

// Adult content goes by BitMagnet's own classification
const shown = item => item.contentType !== 'xxx' && !item.content?.adult

/** One entry per film or show, in the order BitMagnet returned them, skipping unmatched and adult releases. */
export function groupTitles (items) {
  const groups = new Map()
  for (const item of items) {
    if (!item.content || !shown(item)) continue
    const key = `${item.content.source}:${item.content.id}`
    if (!groups.has(key)) groups.set(key, { ...toTitle(item.content), releases: [] })
    groups.get(key).releases.push(toRelease(item))
  }
  return [...groups.values()].map(({ releases, ...title }) => {
    const bySeeders = [...releases].sort((a, b) => (b.seeders ?? 0) - (a.seeders ?? 0))
    const best = bySeeders.find(r => r.likelyDirect) ?? bySeeders[0]
    return { ...title, releaseCount: releases.length, seeders: bySeeders[0].seeders, playable: releases.some(r => r.likelyDirect), best: best.infoHash }
  })
}

/** GraphQL facet filters. BitMagnet's Year is a string scalar. */
function filterFacets ({ type, genre, year, resolution }) {
  return {
    contentType: { filter: [type] },
    ...(genre && { genre: { filter: [genre] } }),
    ...(year && { releaseYear: { filter: [String(year)] } }),
    ...(resolution && { videoResolution: { filter: [resolution] } }),
  }
}

/**
 * @param {{url: string}} opts  BitMagnet's address, e.g. http://bitmagnet:3333
 * @param {{fetch?: typeof fetch}} [deps]
 */
export function createBitmagnetBrowser ({ url }, { fetch: fetchImpl = globalThis.fetch } = {}) {
  const endpoint = new URL('/graphql', url).href

  async function search (input, signal, query = SEARCH) {
    const res = await request(fetchImpl, endpoint, {
      method: 'POST', signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query, variables: { input } }),
    })
    const body = await res.json()
    if (body.errors?.length) throw new SourceError(`BitMagnet: ${body.errors[0].message}`)
    return body.data.torrentContent.search
  }

  return {
    /** A cheap request for the status menu: GraphQL answers at all. */
    async check ({ signal } = {}) {
      const res = await request(fetchImpl, endpoint, {
        method: 'POST', signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: '{ __typename }' }),
      })
      const body = await res.json().catch(() => null)
      if (!body?.data) throw new SourceError('BitMagnet: no GraphQL at this address')
    },

    /** A page of titles. Filters: genre (e.g. tmdb:35), year, resolution (e.g. V1080p); sort 'seeders' or 'added'. */
    async browse ({ type = 'movie', genre, year, resolution, sort = 'seeders', page = 1 } = {}, { signal } = {}) {
      const r = await search({
        facets: filterFacets({ type, genre, year, resolution }),
        orderBy: [{ field: sort === 'added' ? 'published_at' : 'seeders', descending: true }],
        limit: 100,
        page,
        hasNextPage: true,
      }, signal)
      return { titles: groupTitles(r.items), hasMore: !!r.hasNextPage }
    },

    /** How many releases each genre, year and resolution has under the current filters. Slow; cache it. */
    async facets ({ type = 'movie', genre, year, resolution } = {}, { signal } = {}) {
      const facets = filterFacets({ type, genre, year, resolution })
      for (const name of ['genre', 'releaseYear', 'videoResolution']) facets[name] = { ...facets[name], aggregate: true }
      const r = await search({ facets, limit: 1, cached: true }, signal, FACETS)
      const agg = r.aggregations ?? {}
      return {
        genres: (agg.genre ?? []).map(g => ({ value: g.value, label: g.label, count: g.count })).sort((a, b) => b.count - a.count),
        years: (agg.releaseYear ?? []).filter(y => y.value).map(y => ({ value: y.value, count: y.count })).sort((a, b) => b.value - a.value),
        resolutions: (agg.videoResolution ?? []).map(v => ({ value: v.value, count: v.count })),
      }
    },

    /** The newest releases, matched or not (adult ones hidden). */
    async latest ({ type = 'movie', limit = 20 } = {}, { signal } = {}) {
      const r = await search({ facets: { contentType: { filter: [type] } }, orderBy: [{ field: 'published_at', descending: true }], limit }, signal)
      return r.items.filter(shown).map(item => ({ ...toRelease(item), title: item.content ? toTitle(item.content) : null }))
    },

    /** A film or show with its releases, found by searching its name and keeping exact matches. */
    async title ({ type, source, id, title, year }, { signal } = {}) {
      const r = await search({
        queryString: [title, year].filter(Boolean).join(' '),
        facets: { contentType: { filter: [type] } },
        orderBy: [{ field: 'seeders', descending: true }],
        limit: 100,
      }, signal)
      const matches = r.items.filter(i => shown(i) && i.content?.source === source && String(i.content.id) === String(id))
      if (!matches.length) return null
      return { ...toTitle(matches[0].content), releases: matches.map(toRelease) }
    },
  }
}
