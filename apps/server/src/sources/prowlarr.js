// Prowlarr adapter: one REST search across all its torrent indexers.
// Prowlarr has no aggregate Torznab feed (only /{id}/api per indexer), so this uses /api/v1/search instead.
import { release, request } from './release.js'

/**
 * @param {{name: string, url: string, apiKey: string, indexerIds?: string[]}} opts
 *   indexerIds: Prowlarr indexer ids; -2 means every torrent indexer
 * @param {{fetch?: typeof fetch}} [deps]
 */
export function createProwlarrSource ({ name, url, apiKey, indexerIds = ['-2'] }, { fetch: fetchImpl = globalThis.fetch } = {}) {
  return {
    name,
    async search (q, { cat, signal } = {}) {
      const u = new URL('api/v1/search', url.endsWith('/') ? url : url + '/')
      u.searchParams.set('query', q)
      u.searchParams.set('type', 'search')
      u.searchParams.set('limit', '100')
      for (const id of indexerIds) u.searchParams.append('indexerIds', id)
      if (cat) u.searchParams.append('categories', cat)
      const res = await request(fetchImpl, u, { signal, headers: { 'X-Api-Key': apiKey, Accept: 'application/json' } })
      const items = await res.json()
      return (Array.isArray(items) ? items : [])
        .filter(r => r.protocol === 'torrent')
        .map(r => release({
          title: r.title,
          infoHash: r.infoHash,
          // Both are rewritten to Prowlarr proxy links (http, with the API key); a raw magnet only if Prowlarr passes one through
          magnet: r.magnetUrl,
          link: r.magnetUrl || r.downloadUrl,
          size: r.size,
          seeders: r.seeders,
        }, r.indexer ? `${name}/${r.indexer}` : name))
        .filter(Boolean)
    },
  }
}
