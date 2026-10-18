// Searches every configured source in parallel and merges the results.
import { createHash } from 'node:crypto'
import { LinkExpired, NoSourcesError, SourceError, errorMessage, isAbort } from './errors.ts'
import type { Release } from './release.ts'
import type { Source } from './source.ts'

const MAX_LINKS = 5000

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
/** Indexers sometimes send titles still HTML-escaped (`Beltesassar&#39;s`). */
export function decodeEntities (s: string): string {
  return s.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (m, e: string) => e[0] !== '#'
    ? ENTITIES[e.toLowerCase()] ?? m
    : String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))))
}

/** A merged result. The download link stays on the server; the browser gets `linkId` to add it by. */
export type SearchResult = Omit<Release, 'link'> & { linkId: string | null }

export type SourceReport =
  | { name: string, ok: true, count: number, ms: number }
  | { name: string, ok: false, error: string, ms: number }

export interface SearchResponse {
  results: SearchResult[]
  sources: SourceReport[]
}

export interface Search {
  /** Throws NoSourcesError with no sources, and a SourceError naming each source when all of them fail. */
  search: (q: string, cat?: string | null) => Promise<SearchResponse>
  /** The download link behind a result's `linkId`; throws LinkExpired when it's no longer known. */
  linkFor: (id: string) => string
  /** Remembered download links, for the Debug page. */
  linkStats: () => { used: number, limit: number }
  names: string[]
}

export function createSearch (sources: readonly Source[], { timeoutMs = 30_000 }: { timeoutMs?: number } = {}): Search {
  // Download links can carry an indexer's API key, so they stay here and the browser gets an opaque id
  const links = new Map<string, string>()
  const remember = (link: string): string => {
    const id = createHash('sha256').update(link).digest('hex').slice(0, 20)
    links.delete(id)
    links.set(id, link)
    if (links.size > MAX_LINKS) links.delete(links.keys().next().value!)
    return id
  }

  async function search (q: string, cat?: string | null): Promise<SearchResponse> {
    if (!sources.length) throw new NoSourcesError('No search sources are configured. Set TORZNAB_URL, JACKETT_URL or PROWLARR_URL (see the README).')
    const settled = await Promise.all(sources.map(async source => {
      const started = Date.now()
      try {
        const items = await source.search(q, { cat: cat ?? undefined, signal: AbortSignal.timeout(timeoutMs) })
        return { report: { name: source.name, ok: true as const, count: items.length, ms: Date.now() - started }, items }
      } catch (err) {
        const timedOut = isAbort(err)
        const error = timedOut ? `timed out after ${timeoutMs / 1000} s` : err instanceof SourceError ? err.message : `failed: ${errorMessage(err)}`
        if (timedOut || err instanceof SourceError) console.log(`[search] ${source.name} ${error}`)
        else console.error(`[search] ${source.name}:`, err) // a bug, not an indexer problem
        return { report: { name: source.name, ok: false as const, error, ms: Date.now() - started }, items: [] }
      }
    }))
    const failures = settled.map(s => s.report).filter(r => !r.ok)
    if (failures.length === settled.length) throw new SourceError(failures.map(s => `${s.name}: ${s.error}`).join('; '))

    // The same torrent often comes from several indexers: keep one, with the best known numbers
    const merged = new Map<string | null, Release>()
    for (const { items } of settled) {
      for (const item of items) {
        const r = { ...item, title: decodeEntities(item.title) }
        // Without an infohash, each indexer's proxy link differs; the same title and size is the same torrent
        const key = r.infoHash || (r.size ? `${r.title.toLowerCase()}|${r.size}` : r.link)
        const prev = merged.get(key)
        if (!prev) {
          merged.set(key, { ...r, sources: [...r.sources] })
          continue
        }
        if (r.seeders != null && (prev.seeders == null || r.seeders > prev.seeders)) prev.seeders = r.seeders
        prev.size ??= r.size
        for (const s of r.sources) if (!prev.sources.includes(s)) prev.sources.push(s)
      }
    }
    const results = [...merged.values()]
      .sort((a, b) => (b.seeders ?? -1) - (a.seeders ?? -1) || (b.size ?? 0) - (a.size ?? 0))
      .map(({ link, ...r }) => ({ ...r, linkId: link ? remember(link) : null }))
    return { results, sources: settled.map(s => s.report) }
  }

  function linkFor (id: string): string {
    const link = links.get(id)
    if (!link) throw new LinkExpired('This search result has expired. Search again.')
    return link
  }

  return { search, linkFor, linkStats: () => ({ used: links.size, limit: MAX_LINKS }), names: sources.map(s => s.name) }
}
