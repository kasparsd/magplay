// A film or show from Explore, /title/<type>/<source>/<id>?title=&year=: what it is, and its releases in BitMagnet.
import './lib/topbar.ts'
import { api } from './lib/api.ts'
import { $, count, el, fill, posterTile, releaseRow, setError, setStatus } from './lib/ui.ts'
import { urls } from './lib/urls.ts'
import { backTarget } from './lib/back.ts'

const [, , type, source, id] = location.pathname.split('/')
const params = new URLSearchParams(location.search)
const status = $('#status')

// Back to Explore with its filters (or the search) when we came from it, otherwise to Explore for this type
const back = backTarget(document.referrer, location.origin, { label: '← Explore', href: urls.explore({ type: type === 'tv_show' ? type : '' }) })
Object.assign($('#back'), { href: back.href, textContent: back.label })
if (back.history) $('#back').addEventListener('click', e => { e.preventDefault(); history.back() })

const LINK_NAMES = { imdb: 'IMDb', tmdb: 'TMDB', tvdb: 'TheTVDB' }

/** Most seeded first, the same order as Explore's "Most seeded" and the seeders on its tile. */
const bySeeders = releases => [...releases].sort((a, b) => (b.seeders ?? 0) - (a.seeders ?? 0))
/** The release Best release opens: the most seeded one that plays in the browser, otherwise the most seeded. */
const effortRank = r => r.playbackEffort === 'direct' ? 0 : r.playbackEffort === 'remux' ? 1 : r.playbackEffort === 'transcode' ? 2 : 3
const bestOf = releases => [...releases].sort((a, b) => effortRank(a) - effortRank(b) || (b.seeders ?? 0) - (a.seeders ?? 0))[0] ?? releases[0]

/** What Best release chose and why, since it isn't always the top of the list. */
const bestNote = best => best.playbackEffort === 'direct' || best.playbackEffort === 'remux'
  ? `Best release: the lowest-effort one that plays in the browser (${count(best.seeders ?? 0, 'seeder')}).`
  : `Best release: the most seeded one (${count(best.seeders ?? 0, 'seeder')}). None looks like it plays cheaply, so the player converts it.`

function renderHeader (t, best) {
  const query = [t.title, t.year].filter(Boolean).join(' ')
  return [
    posterTile(t.title, 'large'),
    el('div', { className: 'about' },
      el('h1', {}, t.title, t.year && el('span', { className: 'year', textContent: ` ${t.year}` })),
      el('p', { className: 'meta' },
        [t.rating && `★ ${t.rating}`, t.runtime && `${t.runtime} min`, t.genres.join(', ')].filter(Boolean).join(' · '),
        ...t.links.filter(l => LINK_NAMES[l.source]).flatMap(l => [' · ', el('a', { href: l.url, textContent: LINK_NAMES[l.source], target: '_blank', rel: 'noopener noreferrer' })])),
      t.overview && el('p', { className: 'overview', textContent: t.overview }),
      el('p', { className: 'actions' },
        best && el('a', { className: 'button primary', href: urls.torrent(best.infoHash, { title: best.name }), title: best.name },
          (best.playbackEffort === 'direct' || best.playbackEffort === 'remux') ? '▶ Best release' : 'Open best release'),
        el('a', { className: 'button', href: urls.search(query), textContent: 'Search all sources' })),
      best && el('p', { className: 'meta best-note', textContent: bestNote(best) })),
  ]
}

async function load () {
  const title = params.get('title') || 'Title'
  document.title = `${title} · magplay`
  fill($('#header'), posterTile(title, 'large'), el('div', { className: 'about' }, el('h1', { textContent: title })))
  setStatus(status, 'Finding releases…', 'busy')
  let t
  try {
    t = await api(`/api/title/${type}/${source}/${id}?${new URLSearchParams({ title, ...(params.get('year') && { year: params.get('year') }) })}`)
  } catch (err) {
    return setError(status, err.message, load)
  }
  setStatus(status, '')
  const releases = bySeeders(t.releases)
  const best = bestOf(releases)
  fill($('#header'), ...renderHeader(t, best))
  $('#releases h2').textContent = count(releases.length, 'release')
  fill($('#releases ul'), ...releases.map(r => releaseRow(r, urls.torrent(r.infoHash, { title: r.name }), {
    extra: [r === best && el('span', { className: 'badge good', textContent: 'best' })],
  })))
  // BitMagnet's search for the name returned more hits than were read, so this list may be incomplete
  fill($('#releases .truncated'), ...(t.truncated
    ? ['These are the releases among the 100 most-seeded matches for its name; BitMagnet has more. ', el('a', { href: urls.search([t.title, t.year].filter(Boolean).join(' ')), textContent: 'Search all sources' }), ' for the rest.']
    : []))
  $('#releases').hidden = false
}

load()
