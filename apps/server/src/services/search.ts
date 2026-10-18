// Search across the configured sources, rebuilt when the sources or the timeout change.
import { createSearch, createSources } from '@magplay/indexers'
import type { Search, SourceConfig } from '@magplay/indexers'
import type { TorrentEngine } from '@magplay/torrent-engine'
import type { SearchResponse } from '@magplay/api-contract'
import { HttpError } from '../http/errors.ts'

export interface SearchService extends Pick<Search, 'linkFor' | 'linkStats'> {
  search: (q: string | null, cat: string | null) => Promise<SearchResponse>
  rebuild: () => void
}

export function createSearchService ({ sources, timeoutMs, engine }: { sources: () => SourceConfig[], timeoutMs: () => number, engine: TorrentEngine }): SearchService {
  const build = (): Search => createSearch(createSources(sources()), { timeoutMs: timeoutMs() })
  let searcher = build()
  return {
    async search (q, cat) {
      if (!q?.trim()) throw new HttpError(400, 'Type something to search for')
      const out = await searcher.search(q.trim(), cat)
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
