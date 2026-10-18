import { randomUUID } from 'node:crypto'
import { noopLogger, noopMetrics } from '@magplay/observability'
import type { Logger, Metrics, OperationContext } from '@magplay/observability'
// Search across the configured sources, rebuilt when the sources or the timeout change.
import { createSearch, createSources, release } from '@magplay/indexers'
import { readMagnet } from '@magplay/torrent-engine'
import type { Search, SourceConfig } from '@magplay/indexers'
import type { TorrentEngine } from '@magplay/torrent-engine'
import type { SearchResponse } from '@magplay/api-contract'
import { HttpError } from '../http/errors.ts'

export interface SearchService extends Pick<Search, 'linkFor' | 'linkStats'> {
  search: (q: string | null, cat: string | null, context?: OperationContext) => Promise<SearchResponse>
  rebuild: () => void
}

export function createSearchService ({ sources, timeoutMs, engine, logger = noopLogger, metrics = noopMetrics }: { logger?: Logger, metrics?: Metrics, sources: () => SourceConfig[], timeoutMs: () => number, engine: Pick<TorrentEngine, 'knownWarning'> }): SearchService {
  const build = (): Search => {
    const configs = sources()
    return createSearch(createSources(configs), { timeoutMs: timeoutMs(), logger, metrics, sourceIds: configs.map((c, i) => c.id ?? `source-${i}`) })
  }
  let searcher = build()
  return {
    async search (q, cat, context) {
      if (!q?.trim()) throw new HttpError(400, 'Type something to search for')
      const log = (context?.logger ?? logger).child({ component: 'search', operationId: randomUUID() })
      const started = performance.now()
      try {
        const query = q.trim()
        let out: SearchResponse
        if (/^magnet:/i.test(query)) {
          const { magnet, infoHash, name } = await readMagnet(query)
          const { link: _link, ...result } = release({ title: name || `Torrent ${infoHash}`, infoHash, magnet }, 'Magnet link')!
          out = { results: [{ ...result, linkId: null }], sources: [] }
        } else {
          out = await searcher.search(query, cat, { logger: log })
        }
        // A file list seen earlier can tell more than the title
        const results = out.results.map(r => {
          const warning = r.infoHash && engine.knownWarning(r.infoHash)
          return warning ? { ...r, warning, likelyDirect: false } : r
        })
        log.info('search.completed', { count: results.length, durationMs: performance.now() - started })
        return { ...out, results }
      } catch (err) {
        log.warn('search.failed', { reason: err instanceof Error ? err.name : 'unknown', durationMs: performance.now() - started })
        throw err
      }
    },
    linkFor: id => searcher.linkFor(id),
    linkStats: () => searcher.linkStats(),
    rebuild () { searcher = build() },
  }
}
