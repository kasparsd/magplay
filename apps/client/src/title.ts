// A film or show from Explore, /title/<type>/<source>/<id>?title=&year=: what it is, and its releases in BitMagnet.
import './lib/topbar.ts'
import type { ExploreRelease, TitleResponse } from '@magplay/api-contract'
import { api } from './lib/api.ts'
import { requireElement, count, el, fill, posterTile, releaseRow, setError, setStatus } from './lib/ui.ts'
import { urls } from './lib/urls.ts'
import { backTarget } from './lib/back.ts'

const [, , type = '', source = '', id = ''] = location.pathname.split('/')
const params = new URLSearchParams(location.search)
const status = requireElement('#status', HTMLParagraphElement)

// Back to Explore with its filters (or the search) when we came from it, otherwise to Explore for this type
const back = backTarget(document.referrer, location.origin, { label: '← Explore', href: urls.explore({ type: type === 'tv_show' ? type : '' }) })
if (!back) throw new Error('Expected an Explore fallback')
Object.assign(requireElement('#back', HTMLAnchorElement), { href: back.href, textContent: back.label })
if (back.history) requireElement('#back', HTMLAnchorElement).addEventListener('click', e => { e.preventDefault(); history.back() })

const LINK_NAMES: Record<string, string> = { imdb: 'IMDb', tmdb: 'TMDB', tvdb: 'TheTVDB' }

const playbackRank = (effort: ExploreRelease['playbackEffort'] | undefined): number =>
  effort === 'direct' ? 0 : effort === 'remux' ? 1 : 2

/** Most seeded first, the same order as Explore's "Most seeded" and the seeders on its tile. */
const bySeeders = (releases: ExploreRelease[]): ExploreRelease[] => [...releases].sort((a, b) => (b.seeders ?? 0) - (a.seeders ?? 0))
/** The lowest-effort title estimate, breaking ties by seeders. Unknown and transcode rank equally. */
const bestOf = (releases: ExploreRelease[]): ExploreRelease | undefined =>
  [...releases].sort((a, b) => playbackRank(a.playbackEffort) - playbackRank(b.playbackEffort) || (b.seeders ?? 0) - (a.seeders ?? 0))[0]

/** What Best release chose and why, since it isn't always the top of the list. */
const bestNote = (best: ExploreRelease): string => best.playbackEffort === 'direct' || best.playbackEffort === 'remux'
  ? `Best release: the lowest-effort title that looks playable without re-encoding video (${count(best.seeders ?? 0, 'seeder')}).`
  : `Best release: the most seeded one (${count(best.seeders ?? 0, 'seeder')}).`

function renderHeader (t: TitleResponse, best: ExploreRelease | undefined): HTMLElement[] {
  const query = [t.title, t.year].filter(Boolean).join(' ')
  return [
    posterTile(t.title, 'large'),
    el('div', { className: 'about' },
      el('h1', {}, t.title, t.year != null && el('span', { className: 'year', textContent: ` ${t.year}` })),
      el('p', { className: 'meta' },
        [t.rating && `★ ${t.rating}`, t.runtime && `${t.runtime} min`, t.genres.join(', ')].filter(Boolean).join(' · '),
        ...t.links.flatMap(l => {
          const name = LINK_NAMES[l.source]
          return name ? [' · ', el('a', { href: l.url, textContent: name, target: '_blank', rel: 'noopener noreferrer' })] : []
        })),
      t.overview && el('p', { className: 'overview', textContent: t.overview }),
      el('p', { className: 'actions' },
        best && el('a', { className: 'button primary', href: urls.torrent(best.infoHash, { title: best.name }), title: best.name },
          (best.playbackEffort === 'direct' || best.playbackEffort === 'remux') ? '▶ Best release' : 'Open best release'),
        el('a', { className: 'button', href: urls.search(query), textContent: 'Search all sources' })),
      best && el('p', { className: 'meta best-note', textContent: bestNote(best) })),
  ]
}

async function load (): Promise<void> {
  const title = params.get('title') || 'Title'
  document.title = `${title} · magplay`
  fill(requireElement('#header', HTMLDivElement), posterTile(title, 'large'), el('div', { className: 'about' }, el('h1', { textContent: title })))
  setStatus(status, 'Finding releases…', 'busy')
  let t: TitleResponse
  try {
    t = await api<TitleResponse>(`/api/title/${type}/${source}/${id}?${new URLSearchParams({ title, ...(params.get('year') && { year: params.get('year')! }) })}`)
  } catch (err) {
    setError(status, err instanceof Error ? err.message : String(err), () => { load().catch(console.error) })
    return
  }
  setStatus(status, '')
  const releases = bySeeders(t.releases)
  const best = bestOf(releases)
  fill(requireElement('#header', HTMLDivElement), ...renderHeader(t, best))
  requireElement('#releases h2', HTMLHeadingElement).textContent = count(releases.length, 'release')
  fill(requireElement('#releases ul', HTMLUListElement), ...releases.map(r => releaseRow(r, urls.torrent(r.infoHash, { title: r.name }), {
    extra: [r === best && el('span', { className: 'badge good', textContent: 'best' })],
  })))
  // BitMagnet's search for the name returned more hits than were read, so this list may be incomplete
  fill(requireElement('#releases .truncated', HTMLParagraphElement), ...(t.truncated
    ? ['These are the releases among the 100 most-seeded matches for its name; BitMagnet has more. ', el('a', { href: urls.search([t.title, t.year].filter(Boolean).join(' ')), textContent: 'Search all sources' }), ' for the rest.']
    : []))
  requireElement('#releases', HTMLElement).hidden = false
}

load().catch(console.error)
