// The search page, /?q=…&cat=…: results from every source, each linking to its torrent page.
import './lib/topbar.ts'
import type { RecentTorrent, SearchResponse, SearchResult, SourceReport } from '@magplay/api-contract'
import { api } from './lib/api.ts'
import { createCache, sessionStore, takeLatest } from './lib/resource.ts'
import { $, el, fill, formatBytes, recall, releaseRow, remember, rememberSearch, requireElement, setError, setStatus, timeAgo } from './lib/ui.ts'
import { urlState } from './lib/url-state.ts'
import { urls } from './lib/urls.ts'

const CATEGORIES = ['', '2000', '5000', '3000', '4000', '7000', '8000'] as const
const url = urlState({ q: { default: '' }, cat: { default: '', values: CATEGORIES } })
// Per tab, so Back from a torrent page shows the same results at once instead of searching again
const cache = createCache(sessionStore())
const beginSearch = takeLatest()
const form = requireElement('#search', HTMLFormElement)
const query = form.elements.namedItem('q') as HTMLInputElement
const categories = form.elements.namedItem('cat') as RadioNodeList
const status = $('#status')
const results = $('#results')

/** One result. Where it came from is only worth a line when more than one source is configured. */
function renderResult (item: SearchResult, sourceCount: number): HTMLLIElement {
  const href = urls.torrent(item.infoHash, { title: item.title, link: item.linkId, magnet: item.magnet })
  return releaseRow({ ...item, name: item.title }, href, { note: sourceCount > 1 ? item.sources.join(', ') : null })
}

/** One chip per answering source with its count, and a readable line for each one that failed. */
function renderSources (sources: SourceReport[], retry: () => void): void {
  fill($('#sources'), ...(sources.length > 1
    ? sources.flatMap(s => s.ok ? [el('span', { className: 'chip', textContent: `${s.name} ${s.count}`, title: `${s.count} results in ${(s.ms / 1000).toFixed(1)} s` })] : [])
    : []))
  const failed = sources.flatMap(s => s.ok ? [] : [s])
  fill($('#source-errors'), ...failed.map(s => el('li', {}, el('strong', { textContent: s.name }), `: ${s.error}`)),
    failed.length > 0 && el('li', {}, el('button', { type: 'button', className: 'retry', textContent: 'Search again', onclick: retry })))
}

function show ({ results: items, sources }: SearchResponse, retry: () => void): void {
  setStatus(status, items.length ? `${items.length} result${items.length === 1 ? '' : 's'}` : 'Nothing found.')
  renderSources(sources, retry)
  fill(results, ...items.map(item => renderResult(item, sources.length)))
  results.hidden = !items.length
}

addEventListener('pagehide', () => { try { sessionStorage.setItem('lastScroll', String(scrollY)) } catch {} })

/** A new search always asks the sources; Back and Forward reuse the tab's results from the last 3 minutes. */
async function runSearch (q: string, cat: string, { restore = false } = {}): Promise<void> {
  const signal = beginSearch()
  const key = `search:${q}|${cat}`
  const retry = (): void => { runSearch(q, cat).catch(console.error) }
  $('#toolbar').hidden = false
  $('#recent').hidden = true
  setStatus(status, 'Searching…', 'busy')
  fill($('#sources'))
  fill($('#source-errors'))
  results.hidden = true
  if (!restore) cache.invalidate(key)
  try {
    const data = await cache.get(key, s => api<SearchResponse>(`/api/search?${new URLSearchParams({ q, cat })}`, { signal: s }), { staleMs: 180_000, signal })
    show(data, retry)
    if (restore) try { scrollTo(0, Number(sessionStorage.getItem('lastScroll')) || 0) } catch {}
  } catch (err) {
    if (!signal.aborted) setError(status, err instanceof Error ? err.message : String(err), retry)
  }
}

/** A new query is a new history entry, so Back returns to the previous search; a category switch replaces it. */
function submit ({ push }: { push: boolean }): void {
  const q = query.value.trim()
  if (!q) return
  rememberSearch(q)
  url.set({ q, cat: categories.value }, { push: push && url.get().q !== q })
  runSearch(q, categories.value).catch(console.error)
}
form.addEventListener('submit', e => { e.preventDefault(); submit({ push: true }) })
// Switching category searches again straight away
for (const radio of form.querySelectorAll('input[name="cat"]')) radio.addEventListener('change', () => { submit({ push: false }) })

/** The home page: torrents already in the cache, with where this browser left off. */
async function showRecent (): Promise<void> {
  const signal = beginSearch() // a search started meanwhile wins
  $('#toolbar').hidden = true
  fill($('#sources'))
  fill($('#source-errors'))
  results.hidden = true
  const list = await api<RecentTorrent[]>('/api/recent', { signal }).catch(() => null)
  if (signal.aborted) return
  // Removing hides an item in this browser until it's opened again; nothing leaves the cache
  const hidden = new Map(Object.entries((recall('hiddenRecent') ?? {}) as Record<string, number>))
  const shown = (list ?? []).filter(t => !((hidden.get(t.infoHash) ?? -1) >= t.lastUsed))
  const remove = (t: RecentTorrent, row: HTMLLIElement): void => {
    hidden.set(t.infoHash, Date.now())
    remember('hiddenRecent', Object.fromEntries([...hidden].filter(([ih]) => list?.some(t => t.infoHash === ih))))
    row.remove()
    if (!$('#recent li')) showRecent().catch(console.error)
  }
  fill($('#recent'), ...(shown.length
    ? [el('h2', { textContent: 'Recently opened' }), el('ul', {}, ...shown.map(t => {
        const last = recall(`last:${t.infoHash}`) as { label: string, at: number } | null
        const onServer = t.length ? Math.round((t.onDisk / t.length) * 100) : 0
        const row = el('li', {},
          el('div', { className: 'main' },
            el('a', { className: 'title', href: urls.torrent(t.infoHash, { title: t.name }), textContent: t.name ?? t.infoHash }),
            el('div', { className: 'meta' }, [
              last && `last played ${last.label}, ${timeAgo(last.at)}`,
              !last && `opened ${timeAgo(t.lastUsed)}`,
              `${formatBytes(t.length)}, ${onServer}% on the server`,
            ].filter(Boolean).join(' · '))))
        row.append(el('button', { type: 'button', className: 'remove', textContent: '✕', title: 'Remove from this list (the files stay on the server)', ariaLabel: `Remove ${t.name} from this list`, onclick: () => { remove(t, row) } }))
        return row
      }))]
    : [el('p', { className: 'help' }, 'Search every configured source for a film, show or anything else with a torrent, paste a magnet link, or ', el('a', { href: urls.explore(), textContent: 'explore what BitMagnet has found' }), '. Torrents you open are listed here.')]))
  $('#recent').hidden = false
}

/** Shows what the URL says: a search, or the home page. */
function fromUrl ({ restore = false } = {}): void {
  const { q, cat } = url.get()
  query.value = q
  categories.value = cat
  if (!q) {
    // Only the empty home page puts the cursor in the search box; results and Back leave focus alone
    if (!restore) query.focus()
    showRecent().catch(console.error)
    return
  }
  rememberSearch(q)
  runSearch(q, cat, { restore }).catch(console.error)
}

// The search lives in the URL, so reload, Back and links from other pages all work
const navigation = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined
fromUrl({ restore: navigation?.type === 'back_forward' })
url.onChange(() => { fromUrl({ restore: true }) })
