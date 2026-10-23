import { noopLogger, noopMetrics, observeJob } from '@magplay/observability'
import type { Logger, Metrics } from '@magplay/observability'
// Explore: BitMagnet's browser behind a short cache, with its query parameters checked.
import { createBitmagnetBrowser, isContentType } from '@magplay/indexers'
import type { BitmagnetBrowser, BrowseOptions, ContentType, FacetFilter } from '@magplay/indexers'
import type { ExploreFacets, ExploreResponse, LatestRelease, TitleResponse } from '@magplay/api-contract'
import { HttpError } from '../http/errors.ts'

const FACETS_TTL = 15 * 60_000
const FACETS_TIMEOUT_MS = 120_000
const CACHE_LIMIT = 200

export interface ExploreOptions {
  logger?: Logger
  metrics?: Metrics
  /** BitMagnet's origin, read when the service is (re)built; null turns Explore off. */
  url: () => string | null
  timeoutMs: () => number
  /** Whether adult content may be browsed. */
  showAdult?: () => boolean
  /** Replaceable for tests. */
  createBrowser?: (url: string) => BitmagnetBrowser
}

export type ExploreParams = Required<Pick<BrowseOptions, 'type' | 'sort' | 'page'>> & Omit<FacetFilter, 'type'>

export interface Explore {
  /** Explore's query parameters, checked: type, genre, year, res, sort, page. */
  params: (query: URLSearchParams) => ExploreParams
  browse: (params: ExploreParams) => Promise<ExploreResponse>
  facets: (params: ExploreParams) => Promise<ExploreFacets>
  latest: (params: ExploreParams) => Promise<LatestRelease[]>
  title: (type: string, source: string, id: string, query: URLSearchParams) => Promise<TitleResponse>
  /** Rebuilds the browser after BitMagnet's address changed, clearing the cache and warming the counts again. */
  rebuild: () => void
  /** Counts for the unfiltered tabs take a while on a big index, so start them early. */
  warm: () => void
  /** Cached answers, for the Debug page. */
  cacheStats: () => { used: number, limit: number }
}

const unavailable = (): HttpError => new HttpError(404, 'Explore needs BitMagnet. Set its address in Settings → Sources.')

export function createExplore ({ url, timeoutMs, logger = noopLogger, metrics = noopMetrics, showAdult, createBrowser = u => createBitmagnetBrowser({ url: u, showAdult: showAdult ?? (() => false) }) }: ExploreOptions): Explore {
  const showAdultFn = showAdult ?? (() => false)
  let browser: BitmagnetBrowser | null = null
  // Explore answers are cached briefly: browsing goes back and forth over the same filters
  const cache = new Map<string, { at: number, value: Promise<unknown> }>()

  function build (): void {
    const u = url()
    browser = u ? createBrowser(u) : null
    cache.clear()
  }
  build()

  function cached<T> (key: string, load: () => Promise<T>, ttl = 60_000): Promise<T> {
    const hit = cache.get(key)
    if (hit && Date.now() - hit.at < ttl) return hit.value as Promise<T>
    const value = observeJob(logger, metrics, 'explore', async () => await load()).catch((err: unknown) => {
      cache.delete(key)
      throw err
    })
    cache.set(key, { at: Date.now(), value })
    if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!)
    return value
  }

  const ready = (): BitmagnetBrowser => {
    if (!browser) throw unavailable()
    return browser
  }
  const signal = (ms = timeoutMs()): { signal: AbortSignal } => ({ signal: AbortSignal.timeout(ms) })

  function loadFacets ({ type, genre, year, resolution }: FacetFilter & { type: ContentType }): Promise<ExploreFacets> {
    const b = ready()
    const filter = { type, genre, year, resolution }
    return cached(`facets:${JSON.stringify(filter)}`, () => b.facets(filter, signal(FACETS_TIMEOUT_MS)), FACETS_TTL)
  }

  function warm (): void {
    if (!browser) return
    for (const type of ['movie', 'tv_show'] as const) {
      loadFacets({ type }).catch(() => {})
    }
  }

  return {
    params (query) {
      ready()
      const type = query.get('type') || 'movie'
      if (!isContentType(type)) throw new HttpError(400, 'type must be a known content type')
      if (type === 'xxx' && !showAdultFn()) throw new HttpError(403, 'Adult content is disabled in Settings')
      const genre = query.get('genre') || undefined
      const year = query.get('year') ? Number(query.get('year')) : undefined
      const resolution = query.get('res') || undefined
      if ((genre && !/^[\w:.-]+$/.test(genre)) || (year !== undefined && !Number.isInteger(year)) || (resolution && !/^V\d+p$/.test(resolution))) {
        throw new HttpError(400, 'Bad filter')
      }
      return { type, genre, year, resolution, sort: query.get('sort') === 'added' ? 'added' : 'seeders', page: Math.max(1, Number(query.get('page')) || 1) }
    },
    browse (p) {
      const b = ready()
      return cached(JSON.stringify(p), () => b.browse(p, signal()))
    },
    facets: p => loadFacets(p),
    latest ({ type }) {
      const b = ready()
      return cached(`latest:${type}`, () => b.latest({ type }, signal()))
    },
    async title (type, source, id, query) {
      const b = ready()
      if (!isContentType(type)) throw new HttpError(400, 'type must be a known content type')
      if (type === 'xxx' && !showAdultFn()) throw new HttpError(403, 'Adult content is disabled in Settings')
      const t = await cached(`title:${type}:${source}:${id}`, () =>
        b.title({ type, source, id, title: query.get('title'), year: query.get('year') }, signal()))
      if (!t) throw new HttpError(404, 'No releases of this title found any more.')
      return t
    },
    rebuild () {
      build()
      warm()
    },
    warm,
    cacheStats: () => ({ used: cache.size, limit: CACHE_LIMIT }),
  }
}
