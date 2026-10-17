// The explore page, /explore?type=&genre=&year=&res=&sort=: films and shows from BitMagnet, one tile per title.
import { api } from './lib/api.ts'
import { $, count, el, fill, posterTile, releaseRow, setStatus, timeAgo } from './lib/ui.ts'
import { urls } from './lib/urls.ts'

import { latestRequest } from './lib/requests.ts'

const beginBrowse = latestRequest()
const beginLatest = latestRequest()
const form = $('#filters')
const status = $('#status')
const params = new URLSearchParams(location.search)
const filters = {
  type: params.get('type') === 'tv_show' ? 'tv_show' : 'movie', // anything else falls back to films
  sort: params.get('sort') || 'seeders',
  genre: params.get('genre') || '',
  year: params.get('year') || '',
  res: params.get('res') || '',
}
let page = 1
let shown = new Set() // titles already on the page, so "Show more" doesn't repeat them

const RESOLUTIONS = { V2160p: '4K', V1440p: '1440p', V1080p: '1080p', V720p: '720p', V576p: '576p', V480p: '480p' }

function renderTile (t) {
  return el('a', { className: 'tile', href: urls.title(t) },
    posterTile(t.title),
    el('div', { className: 'info' },
      el('div', { className: 'sr-only', textContent: t.title }), // the tile shows it; this names the link for screen readers
      el('div', { className: 'meta', textContent: [t.year, t.rating && `★ ${t.rating}`].filter(Boolean).join(' · ') }),
      t.genres.length > 0 && el('div', { className: 'meta', textContent: t.genres.slice(0, 2).join(', ') }),
      el('div', { className: 'badges' },
        t.playable && el('span', { className: 'badge good', textContent: 'plays in browser' }),
        t.seeders != null && el('span', { className: 'badge', textContent: count(t.seeders, 'seeder') }))))
}

/** Genre chips, year and quality options, from BitMagnet's counts for the current filters. */
function renderFacets ({ genres, years, resolutions }) {
  const chip = (label, value) => el('button', {
    type: 'button',
    className: `chip${filters.genre === value ? ' on' : ''}`,
    textContent: label,
    ariaPressed: String(filters.genre === value),
    onclick: () => apply({ genre: value }),
  })
  fill($('#genres'), chip('All genres', ''), ...genres.slice(0, 14).map(g => chip(`${g.label} ${g.count}`, g.value)))
  const options = (select, list, label) => {
    const current = filters[select.name]
    const choices = list.map(o => new Option(label(o), o.value))
    if (current && !list.some(o => String(o.value) === current)) choices.unshift(new Option(current, current))
    fill(select, select.options[0], ...choices)
    select.value = current
  }
  options(form.year, years.slice(0, 40), y => `${y.value} (${y.count})`)
  const order = Object.keys(RESOLUTIONS) // highest first
  options(form.res, resolutions.filter(r => RESOLUTIONS[r.value]).sort((a, b) => order.indexOf(a.value) - order.indexOf(b.value)), r => `${RESOLUTIONS[r.value]} (${r.count})`)
}

async function load ({ append = false } = {}) {
  const current = beginBrowse()
  const requestedPage = page
  if (!append) {
    page = 1
    shown = new Set()
    fill($('#tiles'))
  }
  setStatus(status, append ? 'Loading more…' : 'Loading…', 'busy')
  $('#more').hidden = true
  try {
    const q = new URLSearchParams({ ...Object.fromEntries(Object.entries(filters).filter(([, v]) => v)), page })
    if (!append) loadFacets(q)
    const data = await api(`/api/explore?${q}`)
    if (!current()) return
    const fresh = data.titles.filter(t => !shown.has(`${t.source}:${t.id}`))
    for (const t of fresh) shown.add(`${t.source}:${t.id}`)
    $('#tiles').append(...fresh.map(renderTile))
    setStatus(status, shown.size ? '' : 'Nothing matches these filters.')
    $('#more').hidden = !data.hasMore
  } catch (err) {
    if (!current()) return
    if (append) {
      page = requestedPage - 1
      $('#more').hidden = false
    }
    setStatus(status, err.message, 'error')
  }
}

async function loadLatest () {
  const current = beginLatest()
  const list = await api(`/api/explore/latest?type=${filters.type}`).catch(() => [])
  if (!current()) return
  fill($('#latest ul'), ...list.map(r => {
    // Matched releases read as "Show · S02E05"; unmatched ones keep their release name
    const name = r.title ? [r.title.title, r.episode].filter(Boolean).join(' · ') : r.name
    const row = releaseRow({ ...r, name, episode: null }, urls.torrent(r.infoHash, { title: r.name }))
    if (r.publishedAt) row.querySelector('.size').prepend(`${timeAgo(Date.parse(r.publishedAt))} · `)
    return row
  }))
  $('#latest').hidden = !list.length
}

/** Counts arrive separately (they can take a while), so the tiles don't wait for them. */
let facetsRun = 0
async function loadFacets (q) {
  const run = ++facetsRun
  if (!$('#genres').children.length) fill($('#genres'), el('span', { className: 'chip', textContent: 'Counting genres…' }))
  const facets = await api(`/api/explore/facets?${q}`).catch(() => null)
  if (run !== facetsRun) return
  if (facets) renderFacets(facets)
  else if ($('#genres').textContent === 'Counting genres…') fill($('#genres'), el('span', { className: 'muted', textContent: 'Genre counts unavailable. Try changing filters.' }))
}

/** Changes filters, keeps them in the URL (so Back and reload work) and reloads. */
function apply (changes) {
  const typeChanged = changes.type && changes.type !== filters.type
  Object.assign(filters, changes)
  if (typeChanged) {
    Object.assign(filters, { genre: '', year: '', res: '' }) // genres differ between films and shows
    facetsRun++ // drop the previous type's counts if they arrive late
    fill($('#genres'))
    for (const select of [form.year, form.res]) fill(select, select.options[0])
  }
  history.replaceState(null, '', urls.explore({ ...filters, type: filters.type === 'movie' ? '' : filters.type, sort: filters.sort === 'seeders' ? '' : filters.sort }))
  form.elements.type.value = filters.type
  form.year.value = filters.year
  form.res.value = filters.res
  load()
  if (typeChanged) loadLatest()
}

form.elements.type.value = filters.type
form.elements.sort.value = filters.sort
// The selects get their options from the first answer; until then, keep the URL's choice as a lone option
for (const name of ['year', 'res']) if (filters[name]) form[name].append(new Option(filters[name], filters[name], true, true))
for (const radio of form.elements.type) radio.addEventListener('change', () => apply({ type: radio.value }))
for (const radio of form.elements.sort) radio.addEventListener('change', () => apply({ sort: radio.value }))
form.year.addEventListener('change', () => apply({ year: form.year.value }))
form.res.addEventListener('change', () => apply({ res: form.res.value }))
form.addEventListener('submit', e => e.preventDefault())
$('#more').addEventListener('click', () => { page++; load({ append: true }) })

load()
loadLatest()
