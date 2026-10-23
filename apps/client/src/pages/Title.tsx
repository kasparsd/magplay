// A film or show from Explore, /title/<type>/<source>/<id>?title=&year=: what it is, and its releases in BitMagnet.
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useParams, useRouter, useSearch } from '@tanstack/react-router'
import type { ExploreRelease, TitleResponse } from '@magplay/api-contract'
import { api } from '../lib/api.ts'
import { backTarget } from '../lib/back.ts'
import { cameFrom } from '../lib/came-from.ts'
import { count } from '../lib/ui.ts'
import { urls } from '../lib/urls.ts'
import { Poster } from '../components/Poster.tsx'
import { ReleaseRow } from '../components/ReleaseRow.tsx'
import { errorText, Status } from '../components/Status.tsx'

export interface TitleSearch { title?: string, year?: string }

const LINK_NAMES: Record<string, string> = { imdb: 'IMDb', tmdb: 'TMDB', tvdb: 'TheTVDB' }

const playbackRank = (effort: ExploreRelease['playbackEffort'] | undefined): number =>
  effort === 'direct' ? 0 : effort === 'remux' ? 1 : 2
const playable = (r: ExploreRelease): boolean => r.playbackEffort === 'direct' || r.playbackEffort === 'remux'

/** Most seeded first, the same order as Explore's "Most seeded" and the seeders on its tile. */
const bySeeders = (releases: ExploreRelease[]): ExploreRelease[] => [...releases].sort((a, b) => (b.seeders ?? 0) - (a.seeders ?? 0))
/** The lowest-effort title estimate, breaking ties by seeders. Unknown and transcode rank equally. */
const bestOf = (releases: ExploreRelease[]): ExploreRelease | undefined =>
  [...releases].sort((a, b) => playbackRank(a.playbackEffort) - playbackRank(b.playbackEffort) || (b.seeders ?? 0) - (a.seeders ?? 0))[0]

/** What Best release chose and why, since it isn't always the top of the list. */
const bestNote = (best: ExploreRelease): string => playable(best)
  ? `Best release: the lowest-effort title that looks playable without re-encoding video (${count(best.seeders ?? 0, 'seeder')}).`
  : `Best release: the most seeded one (${count(best.seeders ?? 0, 'seeder')}).`

/** What to search every source for to find more of its releases. */
const searchFor = (t: TitleResponse): string => [t.title, t.year].filter(Boolean).join(' ')

function About ({ title: t, best }: { title: TitleResponse, best: ExploreRelease | undefined }): ReactNode {
  return (
    <div className='about'>
      <h1>{t.title}{t.year != null && <span className='year'>{` ${t.year}`}</span>}</h1>
      <p className='meta'>
        {[t.rating && `★ ${t.rating}`, t.runtime && `${t.runtime} min`, t.genres.join(', ')].filter(Boolean).join(' · ')}
        {t.links.map(l => LINK_NAMES[l.source] && <span key={l.source}>{' · '}<a href={l.url} target='_blank' rel='noopener noreferrer'>{LINK_NAMES[l.source]}</a></span>)}
      </p>
      {t.overview && <p className='overview'>{t.overview}</p>}
      <p className='actions'>
        {best && <a className='button primary' href={urls.torrent(best.infoHash, { title: best.name })} title={best.name}>{playable(best) ? '▶ Best release' : 'Open best release'}</a>}
        <Link className='button' to='/' search={{ q: searchFor(t) }}>Search all sources</Link>
      </p>
      {best && <p className='meta best-note'>{bestNote(best)}</p>}
    </div>
  )
}

export function TitlePage (): ReactNode {
  const { type, source, id } = useParams({ from: '/title/$type/$source/$id' })
  const { title: name = '', year } = useSearch({ from: '/title/$type/$source/$id' })
  const title = name || 'Title'
  const router = useRouter()
  useEffect(() => { document.title = `${title} · magplay` }, [title])
  // Back to Explore with its filters (or the search) when we came from it, otherwise to Explore for this type
  const [back] = useState(() => backTarget(cameFrom(), location.origin, { label: '← Explore', href: urls.explore({ type: type === 'tv_show' ? type : '' }) })!)
  const result = useQuery({
    queryKey: ['title', type, source, id, title, year],
    queryFn: ({ signal }) => api<TitleResponse>(`/api/title/${type}/${source}/${encodeURIComponent(id)}?${new URLSearchParams({ title, ...(year && { year }) })}`, { signal }),
  })
  const t = result.data
  const releases = t ? bySeeders(t.releases) : []
  const best = bestOf(releases)
  const search = t ? searchFor(t) : ''
  return (
    <main>
      <p className='back'>
        <a id='back' href={back.href} onClick={e => { e.preventDefault(); if (back.history) history.back(); else router.history.push(back.href) }}>{back.label}</a>
      </p>
      <div id='header' className='title-header'>
        <Poster title={t?.title ?? title} large />
        {t ? <About title={t} best={best} /> : <div className='about'><h1>{title}</h1></div>}
      </div>
      <Status
        busy={result.isFetching}
        text={result.isFetching ? 'Finding releases…' : ''}
        error={result.isFetching ? null : errorText(result.error)}
        retry={() => { result.refetch().catch(console.error) }}
      />
      <section id='releases' hidden={!t}>
        <h2>{count(releases.length, 'release')}</h2>
        <ul className='releases'>
          {releases.map(r => (
            <ReleaseRow key={r.infoHash} release={r} href={urls.torrent(r.infoHash, { title: r.name })} extra={r === best && <span className='badge good'>best</span>} />
          ))}
        </ul>
        {/* BitMagnet's search for the name returned more hits than were read, so this list may be incomplete */}
        <p className='truncated'>
          {t?.truncated && <>These are the releases among the 100 most-seeded matches for its name; BitMagnet has more. <Link to='/' search={{ q: search }}>Search all sources</Link> for the rest.</>}
        </p>
      </section>
    </main>
  )
}
