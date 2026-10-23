// The explore page, /explore?type=&genre=&year=&res=&sort=: films and shows from BitMagnet, one tile per title.
import './lib/topbar.ts'
import type { ExploreFacets, ExploreResponse, ExploreTitle, FacetCount, LatestRelease } from '@magplay/api-contract'
import { api } from './lib/api.ts'
import { takeLatest } from './lib/resource.ts'
import { $, count, el, fill, posterTile, releaseRow, requireElement, setError, setStatus, timeAgo } from './lib/ui.ts'
import { urlState } from './lib/url-state.ts'
import type { StateOf } from './lib/url-state.ts'
import { urls } from './lib/urls.ts'

// Unknown types fall through to the server's validation
const schema = {
  type: { default: 'movie' },
  genre: { default: '' },
  year: { default: '' },
  res: { default: '' },
  sort: { default: 'seeders', values: ['seeders', 'added'] },
}
type Filters = StateOf<typeof schema>
const url = urlState(schema)

const beginBrowse = takeLatest()
const beginFacets = takeLatest()
const beginLatest = takeLatest()
const form = requireElement('#filters', HTMLFormElement)
const field = <E extends Element | RadioNodeList>(name: string): E => form.elements.namedItem(name) as E
const typeSelect = field<HTMLSelectElement>('type')
const yearSelect = field<HTMLSelectElement>('year')
const resSelect = field<HTMLSelectElement>('res')
const sortRadios = field<RadioNodeList>('sort')
const status = $('#status')
let filters = url.get()
let page = 1
let shown = new Set<string>() // titles already on the page, so "Show more" doesn't repeat them

const RESOLUTIONS: Record<string, string> = { V2160p: '4K', V1440p: '1440p', V1080p: '1080p', V720p: '720p', V576p: '576p', V480p: '480p' }

function renderTile (t: ExploreTitle): HTMLAnchorElement {
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

// BitMagnet's estimated counts can be 100× off (film genres), so only exact ones are shown
const exact = (o: FacetCount): string => o.estimate || o.count == null ? '' : o.count.toLocaleString()
const optionLabel = (label: string, o: FacetCount): string => exact(o) ? `${label} (${exact(o)})` : label
const TOP_GENRES = 14

/** Genre chips, year and quality options, from BitMagnet's counts for the current filters. */
function renderFacets ({ genres, years, resolutions }: ExploreFacets): void {
  const chip = (label: string, value: string): HTMLButtonElement => el('button', {
    type: 'button',
    className: `chip${filters.genre === value ? ' on' : ''}`,
    textContent: label,
    ariaPressed: String(filters.genre === value),
    onclick: () => { apply({ genre: value }) },
  })
  // The chosen genre always has a chip, even when it isn't among the most common ones
  const top = genres.slice(0, TOP_GENRES)
  const chosen = filters.genre && !top.some(g => g.value === filters.genre) && (genres.find(g => g.value === filters.genre) ?? { value: filters.genre, label: filters.genre, count: 0, estimate: true as const })
  fill($('#genres'), chip('All genres', ''), ...[...top, chosen].flatMap(g => g ? [chip(exact(g) ? `${g.label} ${exact(g)}` : g.label ?? '', String(g.value))] : []))
  const options = (select: HTMLSelectElement, list: FacetCount[], label: (o: FacetCount) => string): void => {
    const current = filters[select.name as 'year' | 'res']
    const choices = list.map(o => new Option(label(o), String(o.value)))
    if (current && !list.some(o => String(o.value) === current)) choices.unshift(new Option(current, current))
    fill(select, select.options[0], ...choices)
    select.value = current
  }
  options(yearSelect, years.slice(0, 40), y => optionLabel(String(y.value), y))
  const order = Object.keys(RESOLUTIONS) // highest first
  options(resSelect, resolutions.filter(r => RESOLUTIONS[String(r.value)]).sort((a, b) => order.indexOf(String(a.value)) - order.indexOf(String(b.value))), r => optionLabel(RESOLUTIONS[String(r.value)]!, r))
}

const apiQuery = (): URLSearchParams => new URLSearchParams({ ...Object.fromEntries(Object.entries(filters).filter(([, v]) => v)), page: String(page) })

async function load ({ append = false } = {}): Promise<void> {
  const signal = beginBrowse()
  const requestedPage = page
  if (!append) {
    page = 1
    shown = new Set()
    fill($('#tiles'))
    loadFacets(apiQuery()).catch(console.error)
  }
  setStatus(status, append ? 'Loading more…' : 'Loading…', 'busy')
  $('#more').hidden = true
  try {
    const data = await api<ExploreResponse>(`/api/explore?${apiQuery()}`, { signal })
    const fresh = data.titles.filter(t => !shown.has(`${t.source}:${t.id}`))
    for (const t of fresh) shown.add(`${t.source}:${t.id}`)
    $('#tiles').append(...fresh.map(renderTile))
    setStatus(status, shown.size ? '' : 'Nothing matches these filters.')
    $('#more').hidden = !data.hasMore
  } catch (err) {
    if (signal.aborted) return
    if (append) {
      page = requestedPage - 1
      $('#more').hidden = false
    }
    setError(status, err instanceof Error ? err.message : String(err), () => {
      if (append) page++
      load({ append }).catch(console.error)
    })
  }
}

async function loadLatest (): Promise<void> {
  const signal = beginLatest()
  const list = await api<LatestRelease[]>(`/api/explore/latest?type=${filters.type}`, { signal }).catch(() => [])
  if (signal.aborted) return
  fill($('#latest ul'), ...list.map(r => {
    // Matched releases read as "Show · S02E05"; unmatched ones keep their release name
    const name = r.title ? [r.title.title, r.episode].filter(Boolean).join(' · ') : r.name
    return releaseRow({ ...r, name, episode: null }, urls.torrent(r.infoHash, { title: r.name }), { meta: [r.publishedAt && timeAgo(Date.parse(r.publishedAt))] })
  }))
  $('#latest').hidden = !list.length
}

/** Counts arrive separately (they can take a while), so the tiles don't wait for them. */
async function loadFacets (q: URLSearchParams): Promise<void> {
  const signal = beginFacets()
  if (!$('#genres').children.length) fill($('#genres'), el('span', { className: 'chip', textContent: 'Counting genres…' }))
  const facets = await api<ExploreFacets>(`/api/explore/facets?${q}`, { signal }).catch(() => null)
  if (signal.aborted) return
  if (facets) {
    renderFacets(facets)
    return
  }
  if ($('#genres').textContent === 'Counting genres…') {
    fill($('#genres'), el('span', { className: 'muted', textContent: 'Genre counts didn\'t arrive in time.' }),
      el('button', { type: 'button', className: 'chip', textContent: 'Try again', onclick: () => { fill($('#genres')); loadFacets(q).catch(console.error) } }))
  }
}

/**
 * Changes filters and reloads. Each change is its own history entry, so Back steps back through the filters
 * (and then off Explore) instead of leaving with every choice lost; reload and shared links keep them too.
 */
function apply (changes: Partial<Filters>, { push = true } = {}): void {
  const typeChanged = changes.type !== undefined && changes.type !== filters.type
  filters = { ...filters, ...changes }
  if (typeChanged) {
    filters = { ...filters, genre: changes.genre ?? '', year: changes.year ?? '', res: changes.res ?? '' } // genres differ between films and shows
    beginFacets() // drop the previous type's counts if they arrive late
    fill($('#genres'))
    for (const select of [yearSelect, resSelect]) fill(select, select.options[0])
  }
  if (push) url.set(filters, { push: true })
  showFilters()
  load().catch(console.error)
  if (typeChanged) loadLatest().catch(console.error)
}

/** Puts the filters into the form. The selects get their options from the facets; until then the choice is a lone option. */
function showFilters (): void {
  typeSelect.value = filters.type
  sortRadios.value = filters.sort
  for (const select of [yearSelect, resSelect]) {
    const value = filters[select.name as 'year' | 'res']
    if (value && ![...select.options].some(o => o.value === value)) select.append(new Option(value, value))
    select.value = value
  }
}

// Back and Forward between filter entries: show what that URL asks for
url.onChange(state => { apply(state, { push: false }) })

showFilters()
typeSelect.addEventListener('change', () => { apply({ type: typeSelect.value }) })
for (const radio of form.querySelectorAll<HTMLInputElement>('input[name="sort"]')) radio.addEventListener('change', () => { apply({ sort: radio.value }) })
yearSelect.addEventListener('change', () => { apply({ year: yearSelect.value }) })
resSelect.addEventListener('change', () => { apply({ res: resSelect.value }) })
form.addEventListener('submit', e => { e.preventDefault() })
$('#more').addEventListener('click', () => { page++; load({ append: true }).catch(console.error) })

load().catch(console.error)
loadLatest().catch(console.error)
