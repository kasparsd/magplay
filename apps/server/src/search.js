// Searches every configured source in parallel and merges the results.
import { createHash } from 'node:crypto'
import { HttpError } from './errors.ts'
import { SourceError } from './sources/release.js'

const MAX_LINKS = 5000

/**
 * @param {Array<{name: string, search: (q: string, opts: {cat?: string, signal: AbortSignal}) => Promise<import('./sources/release.js').Release[]>}>} sources
 * @param {{timeoutMs?: number}} [opts]
 */
export function createSearch (sources, { timeoutMs = 30_000 } = {}) {
  // Download links can carry an indexer's API key, so they stay here and the browser gets an opaque id
  const links = new Map()
  const remember = link => {
    const id = createHash('sha256').update(link).digest('hex').slice(0, 20)
    links.delete(id)
    links.set(id, link)
    if (links.size > MAX_LINKS) links.delete(links.keys().next().value)
    return id
  }

  async function search (q, cat) {
    const settled = await Promise.all(sources.map(async source => {
      const started = Date.now()
      try {
        const items = await source.search(q, { cat, signal: AbortSignal.timeout(timeoutMs) })
        return { name: source.name, ok: true, count: items.length, ms: Date.now() - started, items }
      } catch (err) {
        const timedOut = err.name === 'TimeoutError' || err.name === 'AbortError'
        const error = timedOut ? `timed out after ${timeoutMs / 1000} s` : err instanceof SourceError ? err.message : `failed: ${err.message}`
        if (timedOut || err instanceof SourceError) console.log(`[search] ${source.name} ${error}`)
        else console.error(`[search] ${source.name}:`, err) // a bug, not an indexer problem
        return { name: source.name, ok: false, error, ms: Date.now() - started, items: [] }
      }
    }))
    if (settled.every(s => !s.ok)) throw new HttpError(502, settled.map(s => `${s.name}: ${s.error}`).join('; '))

    // The same torrent often comes from several indexers: keep one, with the best known numbers
    const merged = new Map()
    for (const { items } of settled) {
      for (const r of items) {
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
    return { results, sources: settled.map(({ items, ...s }) => s) }
  }

  return { search, linkFor: id => links.get(id) ?? null, names: sources.map(s => s.name) }
}
