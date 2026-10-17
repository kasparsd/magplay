// A film or show from Explore, /title/<type>/<source>/<id>?title=&year=: what it is, and its releases in BitMagnet.
import './lib/topbar.ts'
import { api } from './lib/api.ts'
import { $, el, fill, posterTile, releaseRow, setStatus } from './lib/ui.ts'
import { urls } from './lib/urls.ts'

const [, , type, source, id] = location.pathname.split('/')
const params = new URLSearchParams(location.search)
const status = $('#status')

// Back to Explore with its filters, when we came from it
const back = $('#back')
if (document.referrer.startsWith(`${location.origin}/explore`)) {
  back.href = document.referrer
  back.addEventListener('click', e => { e.preventDefault(); history.back() })
} else if (type === 'tv_show') {
  back.href = urls.explore({ type })
}

const LINK_NAMES = { imdb: 'IMDb', tmdb: 'TMDB', tvdb: 'TheTVDB' }

function renderHeader (t) {
  const releases = [...t.releases].sort((a, b) => (b.seeders ?? 0) - (a.seeders ?? 0))
  const best = releases.find(r => r.likelyDirect) ?? releases[0]
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
          best.likelyDirect ? '▶ Best release' : 'Open best release'),
        el('a', { className: 'button', href: urls.search(query), textContent: 'Search all sources' }))),
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
    return setStatus(status, err.message, 'error')
  }
  setStatus(status, '')
  fill($('#header'), ...renderHeader(t))
  const releases = [...t.releases].sort((a, b) => (b.likelyDirect - a.likelyDirect) || ((b.seeders ?? 0) - (a.seeders ?? 0)))
  fill($('#releases ul'), ...releases.map(r => releaseRow(r, urls.torrent(r.infoHash, { title: r.name }))))
  $('#releases').hidden = false
}

load()
