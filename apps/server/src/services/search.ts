// Search across the configured sources, rebuilt when the sources or the timeout change.
import { createSearch, createSources, release } from '@magplay/indexers'
import { readMagnet } from '@magplay/torrent-engine'
import type { Search, SourceConfig } from '@magplay/indexers'
import type { TorrentEngine } from '@magplay/torrent-engine'
import type { SearchResponse } from '@magplay/api-contract'
import { HttpError } from '../http/errors.ts'

export interface SearchService extends Pick<Search, 'linkFor' | 'linkStats'> {
  search: (q: string | null, cat: string | null) => Promise<SearchResponse>
  rebuild: () => void
}

export function createSearchService ({ sources, timeoutMs, engine }: { sources: () => SourceConfig[], timeoutMs: () => number, engine: Pick<TorrentEngine, 'knownWarning'> }): SearchService {
  const build = (): Search => createSearch(createSources(sources()), { timeoutMs: timeoutMs() })
  let searcher = build()
  return {
    async search (q, cat) {
      if (!q?.trim()) throw new HttpError(400, 'Type something to search for')
      const query = q.trim()
      let out: SearchResponse
      if (/^magnet:/i.test(query)) {
        const { magnet, infoHash, name } = await readMagnet(query)
        const { link: _link, ...result } = release({ title: name || `Torrent ${infoHash}`, infoHash, magnet }, 'Magnet link')!
        out = { results: [{ ...result, linkId: null }], sources: [] }
      } else {
        out = await searcher.search(query, cat)
      }
      // A file list seen earlier can tell more than the title
      const results = out.results.map(r => {
        const warning = r.infoHash && engine.knownWarning(r.infoHash)
        return warning ? { ...r, warning, likelyDirect: false } : r
      })
      return { ...out, results }
    },
    linkFor: id => searcher.linkFor(id),
    linkStats: () => searcher.linkStats(),
    rebuild () { searcher = build() },
  }
}
