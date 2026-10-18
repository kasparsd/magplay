// The search page, /?q=…&cat=…: results from every source, each linking to its torrent page.
import './lib/topbar.ts'
import { api } from './lib/api.ts'
import { $, el, fill, formatBytes, recall, releaseRow, remember, rememberSearch, setError, setStatus, timeAgo } from './lib/ui.ts'
import { urls } from './lib/urls.ts'

import { latestRequest } from './lib/requests.ts'

const beginSearch = latestRequest()
const form = $('#search')
const status = $('#status')
const results = $('#results')

/** One result. Where it came from is only worth a line when more than one source is configured. */
function renderResult (item, sourceCount) {
  const href = urls.torrent(item.infoHash, { title: item.title, link: item.linkId, magnet: item.magnet })
  return releaseRow({ ...item, name: item.title }, href, { note: sourceCount > 1 && item.sources.join(', ') })
}

/** One chip per answering source with its count, and a readable line for each one that failed. */
function renderSources (sources, retry) {
  const failed = sources.filter(s => !s.ok)
  fill($('#sources'), ...(sources.length > 1 ? sources.filter(s => s.ok).map(s => el('span', { className: 'chip', textContent: `${s.name} ${s.count}`, title: `${s.count} results in ${(s.ms / 1000).toFixed(1)} s` })) : []))
  fill($('#source-errors'), ...failed.map(s => el('li', {}, el('strong', { textContent: s.name }), `: ${s.error}`)),
    failed.length > 0 && el('li', {}, el('button', { type: 'button', className: 'retry', textContent: 'Search again', onclick: retry })))
}

function show ({ results: items, sources }, retry) {
  setStatus(status, items.length ? `${items.length} result${items.length === 1 ? '' : 's'}` : 'Nothing found.')
  renderSources(sources, retry)
  fill(results, ...items.map(item => renderResult(item, sources.length)))
  results.hidden = !items.length
}

// The last results, so Back from a torrent page shows them at once and at the same scroll position
const keepResults = (key, data) => { try { sessionStorage.setItem('lastSearch', JSON.stringify({ key, data })) } catch {} }
const keptResults = key => { try { const last = JSON.parse(sessionStorage.getItem('lastSearch')); return last?.key === key ? last.data : null } catch { return null } }
addEventListener('pagehide', () => { try { sessionStorage.setItem('lastScroll', String(scrollY)) } catch {} })

async function runSearch (q, cat) {
  const current = beginSearch()
  const retry = () => runSearch(q, cat)
  $('#toolbar').hidden = false
  $('#recent').hidden = true
  setStatus(status, 'Searching…', 'busy')
  fill($('#sources'))
  fill($('#source-errors'))
  results.hidden = true
  try {
    const data = await api(`/api/search?${new URLSearchParams({ q, cat })}`)
    if (!current()) return
    keepResults(`${q}|${cat}`, data)
    show(data, retry)
  } catch (err) {
    if (current()) setError(status, err.message, retry)
  }
}

/** A new query is a new history entry, so Back returns to the previous search; a category switch replaces it. */
function submit ({ push }) {
  const q = form.q.value.trim()
  const cat = form.elements.cat.value
  if (!q) return
  rememberSearch(q)
  const url = urls.search(q, cat)
  if (push && new URLSearchParams(location.search).get('q') !== q) history.pushState(null, '', url)
  else history.replaceState(null, '', url)
  runSearch(q, cat)
}
form.addEventListener('submit', e => { e.preventDefault(); submit({ push: true }) })
// Switching category searches again straight away
for (const radio of form.elements.cat) radio.addEventListener('change', () => submit({ push: false }))

/** The home page: torrents already in the cache, with where this browser left off. */
async function showRecent () {
  $('#toolbar').hidden = true
  fill($('#sources'))
  fill($('#source-errors'))
  results.hidden = true
  const list = await api('/api/recent').catch(() => null)
  if (new URLSearchParams(location.search).get('q')) return // a search started meanwhile
  // Removing hides an item in this browser until it's opened again; nothing leaves the cache
  const hidden = new Map(Object.entries(recall('hiddenRecent') ?? {}))
  const shown = (list ?? []).filter(t => !(hidden.get(t.infoHash) >= t.lastUsed))
  const remove = (t, row) => {
    hidden.set(t.infoHash, Date.now())
    remember('hiddenRecent', Object.fromEntries([...hidden].filter(([ih]) => list.some(t => t.infoHash === ih))))
    row.remove()
    if (!$('#recent li')) showRecent()
  }
  fill($('#recent'), ...(shown.length
    ? [el('h2', { textContent: 'Recently opened' }), el('ul', {}, ...shown.map(t => {
        const last = recall(`last:${t.infoHash}`)
        const onServer = t.length ? Math.round((t.onDisk / t.length) * 100) : 0
        const row = el('li', {},
          el('div', { className: 'main' },
            el('a', { className: 'title', href: urls.torrent(t.infoHash, { title: t.name }), textContent: t.name }),
            el('div', { className: 'meta' }, [
              last && `last played ${last.label}, ${timeAgo(last.at)}`,
              !last && `opened ${timeAgo(t.lastUsed)}`,
              `${formatBytes(t.length)}, ${onServer}% on the server`,
            ].filter(Boolean).join(' · '))))
        row.append(el('button', { type: 'button', className: 'remove', textContent: '✕', title: 'Remove from this list (the files stay on the server)', ariaLabel: `Remove ${t.name} from this list`, onclick: () => remove(t, row) }))
        return row
      }))]
    : [el('p', { className: 'help' }, 'Search every configured source for a film, show or anything else with a torrent, paste a magnet link, or ', el('a', { href: urls.explore(), textContent: 'explore what BitMagnet has found' }), '. Torrents you open are listed here.')]))
  $('#recent').hidden = false
}

/** Shows what the URL says: a search, or the home page. */
function fromUrl ({ restore = false } = {}) {
  const query = new URLSearchParams(location.search)
  const q = query.get('q')
  form.q.value = q ?? ''
  form.elements.cat.value = query.get('cat') || ''
  if (!q) return showRecent()
  rememberSearch(q)
  const last = restore && keptResults(`${q}|${form.elements.cat.value}`)
  if (last) {
    $('#toolbar').hidden = false
    $('#recent').hidden = true
    show(last, () => runSearch(q, form.elements.cat.value))
    try { scrollTo(0, Number(sessionStorage.getItem('lastScroll')) || 0) } catch {}
  } else {
    runSearch(q, form.elements.cat.value)
  }
}

// The search lives in the URL, so reload, Back and links from other pages all work
fromUrl({ restore: performance.getEntriesByType('navigation')[0]?.type === 'back_forward' })
addEventListener('popstate', () => fromUrl({ restore: true }))
