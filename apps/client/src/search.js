// The search page, /?q=…&cat=…: results from every source, each linking to its torrent page.
import { api } from './lib/api.ts'
import { $, el, fill, formatBytes, recall, setStatus, timeAgo } from './lib/ui.ts'
import { urls } from './lib/urls.ts'

import { latestRequest } from './lib/requests.ts'

const beginSearch = latestRequest()
const form = $('#search')
const status = $('#status')
const results = $('#results')

function renderResult (item) {
  const href = item.infoHash ? urls.torrent(item.infoHash, { title: item.title }) : urls.torrent(null, { link: item.linkId, title: item.title })
  // The title is the link (keyboard, middle-click, Back); a click anywhere else on the row follows it too
  return el('tr', { onclick: e => { if (!e.target.closest('a')) location.href = href } },
    el('td', {},
      el('a', { className: 'title', href, textContent: item.title }),
      el('div', { className: 'badges' },
        item.warning && el('span', { className: 'badge note', textContent: item.warning }),
        ...item.badges.map(b => el('span', { className: 'badge', textContent: b })),
        item.likelyDirect && el('span', { className: 'badge good', textContent: 'plays in browser', title: 'H.264 with AAC or unknown audio: likely plays in any browser' })),
      el('div', { className: 'meta' }, el('span', {
        className: 'via',
        title: item.sources.join('\n'),
        textContent: item.sources.length > 1 ? `${item.sources.length} sources` : item.sources[0]
      }))),
    el('td', { textContent: formatBytes(item.size) }),
    el('td', { textContent: item.seeders ?? '' }))
}

/** One chip per source: how many results it gave, or why it failed. */
const renderSource = s => s.ok
  ? el('span', { className: 'chip', textContent: `${s.name} ${s.count}`, title: `${s.count} results in ${(s.ms / 1000).toFixed(1)} s` })
  : el('span', { className: 'chip error', textContent: `${s.name} ✕`, title: s.error })

function show ({ results: items, sources }) {
  setStatus(status, items.length ? `${items.length} results` : 'Nothing found.')
  fill($('#sources'), ...(sources.length > 1 || sources.some(s => !s.ok) ? sources.map(renderSource) : []))
  fill(results.tBodies[0], ...items.map(renderResult))
  results.hidden = !items.length
}

// The last results, so Back from a torrent page shows them at once and at the same scroll position
const remember = (key, data) => { try { sessionStorage.setItem('lastSearch', JSON.stringify({ key, data })) } catch {} }
const remembered = key => { try { const last = JSON.parse(sessionStorage.getItem('lastSearch')); return last?.key === key ? last.data : null } catch { return null } }
addEventListener('pagehide', () => { try { sessionStorage.setItem('lastScroll', String(scrollY)) } catch {} })

async function runSearch (q, cat) {
  const current = beginSearch()
  setStatus(status, 'Searching…', 'busy')
  fill($('#sources'))
  results.hidden = true
  try {
    const data = await api(`/api/search?${new URLSearchParams({ q, cat })}`)
    if (!current()) return
    remember(`${q}|${cat}`, data)
    show(data)
  } catch (err) {
    if (current()) setStatus(status, err.message, 'error')
  }
}

function submit () {
  const q = form.q.value.trim()
  const cat = form.elements.cat.value
  if (!q) return
  history.replaceState(null, '', urls.search(q, cat))
  runSearch(q, cat)
}
form.addEventListener('submit', e => { e.preventDefault(); submit() })
// Switching category searches again straight away
for (const radio of form.elements.cat) radio.addEventListener('change', submit)

/** The home page: torrents already in the cache, with where this browser left off. */
async function showRecent () {
  const list = await api('/api/recent').catch(() => [])
  if (!list.length) return
  fill($('#recent'), el('h2', { textContent: 'Recently opened' }), el('ul', {}, ...list.map(t => {
    const last = recall(`last:${t.infoHash}`)
    const onNas = t.length ? Math.round((t.onDisk / t.length) * 100) : 0
    return el('li', {},
      el('a', { className: 'title', href: urls.torrent(t.infoHash, { title: t.name }), textContent: t.name }),
      el('div', { className: 'meta' }, [
        last && `last played ${last.label}, ${timeAgo(last.at)}`,
        !last && `opened ${timeAgo(t.lastUsed)}`,
        `${formatBytes(t.length)}, ${onNas}% on the NAS`,
      ].filter(Boolean).join(' · ')))
  })))
  $('#recent').hidden = false
}

// The search lives in the URL, so reload, Back and links from other pages all work
const initial = new URLSearchParams(location.search)
if (!initial.get('q')) showRecent()
if (initial.get('q')) {
  form.q.value = initial.get('q')
  form.elements.cat.value = initial.get('cat') || ''
  const backForward = performance.getEntriesByType('navigation')[0]?.type === 'back_forward'
  const last = backForward && remembered(`${form.q.value}|${form.elements.cat.value}`)
  if (last) {
    show(last)
    try { scrollTo(0, Number(sessionStorage.getItem('lastScroll')) || 0) } catch {}
  } else {
    runSearch(form.q.value, form.elements.cat.value)
  }
}
