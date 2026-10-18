// Prowlarr adapter: one REST search across all its torrent indexers.
// Prowlarr has no aggregate Torznab feed (only /{id}/api per indexer), so this uses /api/v1/search instead.
import { asArray, asRecord, asString, readJson, release, request } from './release.ts'
import type { Fetch, Release } from './release.ts'
import type { CheckOptions, SearchOptions, Source } from './source.ts'

export interface ProwlarrOptions {
  name: string
  url: string
  apiKey: string
  /** Prowlarr indexer ids; -2 means every torrent indexer. */
  indexerIds?: string[]
}

export function createProwlarrSource ({ name, url, apiKey, indexerIds = ['-2'] }: ProwlarrOptions, { fetch: fetchImpl = globalThis.fetch }: { fetch?: Fetch } = {}): Source {
  const base = url.endsWith('/') ? url : url + '/'
  const headers = { 'X-Api-Key': apiKey, Accept: 'application/json' }
  return {
    name,
    async search (q: string, { cat, signal }: SearchOptions) {
      const u = new URL('api/v1/search', base)
      u.searchParams.set('query', q)
      u.searchParams.set('type', 'search')
      u.searchParams.set('limit', '100')
      for (const id of indexerIds) u.searchParams.append('indexerIds', id)
      if (cat) u.searchParams.append('categories', cat)
      const res = await request(fetchImpl, u, { signal, headers })
      return parseProwlarrResults(await readJson(res, name), name)
    },
    /** A cheap request for the status menu: Prowlarr's health endpoint, which needs the API key. */
    async check ({ signal }: CheckOptions = {}) {
      await request(fetchImpl, new URL('api/v1/health', base), { headers, ...(signal && { signal }) })
    },
  }
}

/** /api/v1/search JSON to Releases: torrents only, each named after the Prowlarr indexer it came from. */
export function parseProwlarrResults (body: unknown, source: string): Release[] {
  return asArray(body).map(asRecord)
    .filter(r => r.protocol === 'torrent')
    .map(r => {
      const indexer = asString(r.indexer)
      return release({
        title: r.title,
        infoHash: r.infoHash,
        // Both are rewritten to Prowlarr proxy links (http, with the API key); a raw magnet only if Prowlarr passes one through
        magnet: r.magnetUrl,
        link: r.magnetUrl || r.downloadUrl,
        size: r.size,
        seeders: r.seeders,
      }, indexer ? `${source}/${indexer}` : source)
    })
    .filter(r => r !== null)
}
