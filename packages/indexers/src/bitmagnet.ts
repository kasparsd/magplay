// BitMagnet's GraphQL API, for browsing: it classifies torrents against TMDB, so it can filter by type, genre, year and
// resolution and return titles with metadata. Search still goes through Torznab (torznab.ts).
import { badges } from '@magplay/release-info'
import type { TitleBadges } from '@magplay/release-info'
import { SearchTimeout, SourceError } from './errors.ts'
import { asArray, asNumber, asRecord, asString, readJson, request } from './release.ts'
import type { Fetch } from './release.ts'
import type { CheckOptions } from './source.ts'

const ITEM_FIELDS = `infoHash contentType seeders publishedAt videoResolution episodes { label } torrent { name size }
  content { type source id title releaseYear voteAverage runtime overview adult collections { type name } externalLinks { metadataSource { key } url } }`

const SEARCH = `query($input: TorrentContentSearchQueryInput!) { torrentContent { search(input: $input) {
  hasNextPage items { ${ITEM_FIELDS} } } } }`

// Counts are slow on a big index (tens of seconds for TV), so they're a separate, cacheable query.
// Within its default aggregation budget BitMagnet answers some counts with Postgres planner estimates, which can be off
// by 100× (film genres: Drama ≈675 against an exact 82,587). Exact ones cost 35–50 s per type and starve searches while
// they run, so the budget stays and estimated counts are marked for the page to leave out.
const FACETS = `query($input: TorrentContentSearchQueryInput!) { torrentContent { search(input: $input) {
  aggregations { genre { value label count isEstimate } releaseYear { value count isEstimate } videoResolution { value count isEstimate } } } } }`

export const TYPES = ['movie', 'tv_show', 'music', 'audiobook', 'ebook', 'comic', 'game', 'software', 'xxx', 'unknown'] as const
export type ContentType = typeof TYPES[number]
export const isContentType = (v: unknown): v is ContentType => TYPES.includes(v as ContentType)
export const TITLE_SEARCH_LIMIT = 100

// What BitMagnet sends, after parsing. Optional fields are null when missing.

export interface BitmagnetContent {
  type: string
  source: string
  id: string
  title: string
  releaseYear: number | null
  voteAverage: number | null
  runtime: number | null
  overview: string | null
  adult: boolean
  genres: string[]
  links: Array<{ source: string, url: string }>
}

export interface BitmagnetItem {
  infoHash: string
  contentType: string | null
  seeders: number | null
  publishedAt: string | null
  episode: string | null
  torrent: { name: string | null, size: number | null }
  content: BitmagnetContent | null
}

export interface Aggregation { value: string | number | null, label: string | null, count: number, isEstimate: boolean }

export interface SearchResult {
  hasNextPage: boolean
  items: BitmagnetItem[]
  aggregations: { genre: Aggregation[], releaseYear: Aggregation[], videoResolution: Aggregation[] }
}

const orNull = <T>(v: T | undefined): T | null => v ?? null

function parseContent (raw: unknown): BitmagnetContent | null {
  const c = asRecord(raw)
  const source = asString(c.source)
  const id = asString(c.id) ?? asNumber(c.id)?.toString()
  if (!source || !id) return null
  return {
    type: asString(c.type) ?? '',
    source,
    id,
    title: asString(c.title) ?? '',
    releaseYear: orNull(asNumber(c.releaseYear)),
    voteAverage: orNull(asNumber(c.voteAverage)),
    runtime: orNull(asNumber(c.runtime)),
    overview: orNull(asString(c.overview)),
    adult: c.adult === true,
    genres: asArray(c.collections).map(asRecord).filter(g => g.type === 'genre').map(g => asString(g.name)).filter(n => n !== undefined),
    links: asArray(c.externalLinks).map(asRecord).flatMap(l => {
      const source = asString(asRecord(l.metadataSource).key)
      const url = asString(l.url)
      return source && url ? [{ source, url }] : []
    }),
  }
}

function parseItem (raw: unknown): BitmagnetItem | null {
  const item = asRecord(raw)
  const infoHash = asString(item.infoHash)
  if (!infoHash) return null
  const torrent = asRecord(item.torrent)
  return {
    infoHash,
    contentType: orNull(asString(item.contentType)),
    seeders: orNull(asNumber(item.seeders)),
    publishedAt: orNull(asString(item.publishedAt)),
    episode: orNull(asString(asRecord(item.episodes).label)),
    torrent: { name: orNull(asString(torrent.name)), size: orNull(asNumber(torrent.size)) },
    content: item.content ? parseContent(item.content) : null,
  }
}

function parseAggregation (raw: unknown): Aggregation[] {
  return asArray(raw).map(asRecord).map(a => {
    const value = a.value
    return {
      value: typeof value === 'string' || typeof value === 'number' ? value : null,
      label: orNull(asString(a.label)),
      count: asNumber(a.count) ?? 0,
      isEstimate: a.isEstimate === true,
    }
  })
}

/** A torrentContent.search answer; GraphQL errors and malformed bodies throw a SourceError. */
export function parseSearchResponse (body: unknown): SearchResult {
  const root = asRecord(body)
  const [error] = asArray(root.errors)
  if (error !== undefined) throw new SourceError(`BitMagnet: ${asString(asRecord(error).message) ?? 'unknown error'}`)
  const search = asRecord(asRecord(asRecord(root.data).torrentContent).search)
  if (!Object.keys(search).length) throw new SourceError('BitMagnet: unexpected answer')
  const aggregations = asRecord(search.aggregations)
  return {
    hasNextPage: search.hasNextPage === true,
    items: asArray(search.items).map(parseItem).filter(i => i !== null),
    aggregations: {
      genre: parseAggregation(aggregations.genre),
      releaseYear: parseAggregation(aggregations.releaseYear),
      videoResolution: parseAggregation(aggregations.videoResolution),
    },
  }
}

export interface ExploreRelease extends TitleBadges {
  infoHash: string
  name: string
  size: number | null
  seeders: number | null
  episode: string | null
  publishedAt: string | null
}

export interface ExploreTitleInfo {
  type: string
  source: string
  id: string
  title: string
  year: number | null
  rating: number | null
  runtime: number | null
  overview: string | null
  genres: string[]
  links: Array<{ source: string, url: string }>
}

export interface ExploreTitle extends ExploreTitleInfo {
  seeders: number | null
  playable: boolean
  /** Info hash of the release to play: one that plays in a browser when any does, otherwise the most seeded. */
  best: string
}

export interface LatestRelease extends ExploreRelease {
  title: ExploreTitleInfo | null
}

export interface TitleReleases extends ExploreTitleInfo {
  releases: ExploreRelease[]
  /** The search had more hits than were read. */
  truncated: boolean
}

export interface FacetCount { value: string | number | null, count: number, estimate?: true }

export interface Facets {
  genres: Array<FacetCount & { label: string | null }>
  years: FacetCount[]
  resolutions: FacetCount[]
}

/** A release as the pages show it, with the same title badges as search results. */
export function toRelease (item: BitmagnetItem): ExploreRelease {
  const name = item.torrent.name || item.content?.title || item.infoHash
  return {
    infoHash: item.infoHash,
    name,
    size: item.torrent.size,
    seeders: item.seeders,
    episode: item.episode,
    publishedAt: item.publishedAt,
    ...badges(name),
  }
}

/** What the pages need to know about a film or show. */
export function toTitle (content: BitmagnetContent): ExploreTitleInfo {
  return {
    type: content.type,
    source: content.source,
    id: content.id,
    title: content.title,
    year: content.releaseYear,
    rating: content.voteAverage ? Math.round(content.voteAverage * 10) / 10 : null,
    runtime: content.runtime,
    overview: content.overview,
    genres: content.genres,
    links: content.links,
  }
}

// Adult content goes by BitMagnet's own classification
const shown = (item: BitmagnetItem, showAdult = false): boolean => !(item.contentType === 'xxx' && !showAdult) && !(item.content?.adult === true && !showAdult)

/** One entry per film or show, in the order BitMagnet returned them, skipping unmatched and adult releases. */
export function groupTitles (items: BitmagnetItem[], showAdult = false): ExploreTitle[] {
  const groups = new Map<string, { title: ExploreTitleInfo, releases: ExploreRelease[] }>()
  for (const item of items) {
    if (!item.content || !shown(item, showAdult)) continue
    const key = `${item.content.source}:${item.content.id}`
    let group = groups.get(key)
    if (!group) groups.set(key, group = { title: toTitle(item.content), releases: [] })
    group.releases.push(toRelease(item))
  }
  return [...groups.values()].map(({ title, releases }) => {
    const bySeeders = [...releases].sort((a, b) => (b.seeders ?? 0) - (a.seeders ?? 0))
    const top = bySeeders[0]!
    const best = bySeeders.find(r => r.likelyDirect) ?? top
    // Only this page's releases are grouped here, so there's no release count: the title page has the full list
    return { ...title, seeders: top.seeders, playable: releases.some(r => r.likelyDirect), best: best.infoHash }
  })
}

export interface FacetFilter {
  type?: ContentType
  genre?: string | undefined
  year?: number | undefined
  resolution?: string | undefined
}

export interface BrowseOptions extends FacetFilter {
  sort?: 'seeders' | 'added'
  page?: number
}

export interface TitleQuery {
  type: ContentType
  source: string
  id: string
  title: string | null
  year?: string | number | null
}

type GraphqlFacets = Record<string, { filter?: string[], aggregate?: true }>

/** GraphQL facet filters. BitMagnet's Year is a string scalar. */
function filterFacets ({ type = 'movie', genre, year, resolution }: FacetFilter): GraphqlFacets {
  return {
    contentType: { filter: [type] },
    ...(genre && { genre: { filter: [genre] } }),
    ...(year && { releaseYear: { filter: [String(year)] } }),
    ...(resolution && { videoResolution: { filter: [resolution] } }),
  }
}

export interface BitmagnetBrowser {
  /** A cheap request for the status menu: GraphQL answers at all. */
  check: (options?: CheckOptions) => Promise<void>
  /** A page of titles. Filters: genre (e.g. tmdb:35), year, resolution (e.g. V1080p); sort 'seeders' or 'added'. */
  browse: (options?: BrowseOptions, request?: CheckOptions) => Promise<{ titles: ExploreTitle[], hasMore: boolean }>
  /** How many releases each genre, year and resolution has under the current filters. Slow; cache it. */
  facets: (filter?: FacetFilter, request?: CheckOptions) => Promise<Facets>
  /** The newest releases, matched or not (adult ones hidden). */
  latest: (options?: { type?: ContentType, limit?: number }, request?: CheckOptions) => Promise<LatestRelease[]>
  /**
   * A film or show with its releases, found by searching its name and keeping exact matches.
   * Only the TITLE_SEARCH_LIMIT most-seeded search hits are read; `truncated` says there were more.
   */
  title: (query: TitleQuery, request?: CheckOptions) => Promise<TitleReleases | null>
}

/** `url` is BitMagnet's address, e.g. http://bitmagnet:3333. */
export function createBitmagnetBrowser ({ url, showAdult }: { url: string, showAdult?: () => boolean }, { fetch: fetchImpl = globalThis.fetch }: { fetch?: Fetch } = {}): BitmagnetBrowser {
  const showAdultFn = showAdult ?? (() => false)
  const endpoint = new URL('/graphql', url).href
  const post = (body: unknown, signal: AbortSignal | undefined): Promise<Response> => request(fetchImpl, endpoint, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), ...(signal && { signal }),
  })

  async function search (variables: unknown, signal: AbortSignal | undefined, query = SEARCH): Promise<SearchResult> {
    try {
      return parseSearchResponse(await readJson(await post({ query, variables }, signal), 'BitMagnet'))
    } catch (err) {
      if (err instanceof Error && err.name === 'TimeoutError') throw new SearchTimeout('BitMagnet took too long to answer. Try again in a moment.', { cause: err })
      throw err
    }
  }

  return {
    async check ({ signal } = {}) {
      const res = await post({ query: '{ __typename }' }, signal)
      const body: unknown = await readJson(res, 'BitMagnet').catch(() => null)
      if (!asRecord(body).data) throw new SourceError('BitMagnet: no GraphQL at this address')
    },

    async browse ({ type = 'movie', genre, year, resolution, sort = 'seeders', page = 1 } = {}, { signal } = {}) {
      const r = await search({
        input: {
          facets: filterFacets({ type, genre, year, resolution }),
          orderBy: [{ field: sort === 'added' ? 'published_at' : 'seeders', descending: true }],
          limit: 100,
          page,
          hasNextPage: true,
        }
      }, signal)
      return { titles: groupTitles(r.items, showAdultFn()), hasMore: r.hasNextPage }
    },

    async facets ({ type = 'movie', genre, year, resolution } = {}, { signal } = {}) {
      const facets = filterFacets({ type, genre, year, resolution })
      for (const name of ['genre', 'releaseYear', 'videoResolution']) facets[name] = { ...facets[name], aggregate: true }
      const agg = (await search({ input: { facets, limit: 1, cached: true } }, signal, FACETS)).aggregations
      // Any count still estimated is marked, so the page can say so instead of showing it as exact
      const entry = ({ value, count, isEstimate }: Aggregation): FacetCount => ({ value, count, ...(isEstimate && { estimate: true as const }) })
      return {
        genres: agg.genre.map(g => ({ ...entry(g), label: g.label })).sort((a, b) => b.count - a.count),
        years: agg.releaseYear.filter(y => y.value).map(entry).sort((a, b) => Number(b.value) - Number(a.value)),
        resolutions: agg.videoResolution.map(entry),
      }
    },

    async latest ({ type = 'movie', limit = 20 } = {}, { signal } = {}) {
      const r = await search({ input: { facets: { contentType: { filter: [type] } }, orderBy: [{ field: 'published_at', descending: true }], limit } }, signal)
      return r.items.filter(item => shown(item, showAdultFn())).map(item => ({ ...toRelease(item), title: item.content ? toTitle(item.content) : null }))
    },

    async title ({ type, source, id, title, year }, { signal } = {}) {
      const r = await search({
        input: {
          queryString: [title, year].filter(Boolean).join(' '),
          facets: { contentType: { filter: [type] } },
          orderBy: [{ field: 'seeders', descending: true }],
          limit: TITLE_SEARCH_LIMIT,
          hasNextPage: true,
        }
      }, signal)
      const matches = r.items.filter(i => shown(i, showAdultFn()) && i.content?.source === source && i.content.id === String(id))
      const first = matches[0]?.content
      if (!first) return null
      return { ...toTitle(first), releases: matches.map(toRelease), truncated: r.hasNextPage }
    },
  }
}
