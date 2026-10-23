import { useEffect } from 'react'
import type { ReactNode } from 'react'
import { useRouterState } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import type { ExploreRelease, TitleResponse } from '@magplay/api-contract'
import { titleRoute } from './router.tsx'
import { api } from './lib/api.ts'
import { backTarget } from './lib/back.ts'
import { count } from './lib/ui.ts'
import { urls } from './lib/urls.ts'
import { CatalogLink, Poster, ReleaseRow, Status } from './components/Catalog.tsx'

const rank = (r: ExploreRelease): number =>
  r.playbackEffort === 'direct' ? 0 : r.playbackEffort === 'remux' ? 1 : 2
const linkNames: Record<string, string> = { imdb: 'IMDb', tmdb: 'TMDB', tvdb: 'TheTVDB' }
export function Title (): ReactNode {
  const returnTo = useRouterState({ select: (state) => state.location.state.catalogReturn })
  const params = titleRoute.useParams()
  const search = titleRoute.useSearch()
  const back = backTarget(returnTo ? location.origin + returnTo : '', location.origin, {
    label: '← Explore', href: urls.explore({ type: params.type === 'tv_show' ? params.type : '' }),
  })!
  const query = useQuery({
    queryKey: ['title', params, search],
    queryFn: ({ signal }) =>
      api<TitleResponse>(
        `/api/title/${encodeURIComponent(params.type)}/${encodeURIComponent(params.source)}/${encodeURIComponent(params.id)}?${new URLSearchParams(search)}`,
        { signal }
      ),
    staleTime: 180_000,
  })
  const t = query.data
  const name = t?.title ?? (search.title || 'Title')
  useEffect(() => {
    document.title = `${name} · magplay`
  }, [name])
  const releases = t?.releases.toSorted((a, b) => (b.seeders ?? 0) - (a.seeders ?? 0)) ?? []
  const best = releases.toSorted((a, b) => rank(a) - rank(b) || (b.seeders ?? 0) - (a.seeders ?? 0))[0]
  const easy = best && rank(best) < 2
  const all = urls.search([t?.title, t?.year].filter(Boolean).join(' '))
  return (
    <main>
      <p className='back'>
        <CatalogLink id='back' back={!!returnTo && back.history} href={back.href}>{back.label}</CatalogLink>
      </p>
      <div id='header' className='title-header'>
        <Poster title={name} large />
        <div className='about'>
          <h1>
            {name}
            {t?.year != null && <span className='year'> {t.year}</span>}
          </h1>
          {t && (
            <>
              <p className='meta'>
                {[t.rating && `★ ${t.rating}`, t.runtime && `${t.runtime} min`, t.genres.join(', ')]
                  .filter(Boolean)
                  .join(' · ')}
                {t.links.map(
                  (l) =>
                    linkNames[l.source] && (
                      <span key={l.source}>
                        {' '}
                        ·{' '}
                        <a href={l.url} target='_blank' rel='noopener noreferrer'>
                          {linkNames[l.source]}
                        </a>
                      </span>
                    )
                )}
              </p>
              {t.overview && <p className='overview'>{t.overview}</p>}
              <p className='actions'>
                {best && (
                  <CatalogLink
                    className='button primary'
                    href={urls.torrent(best.infoHash, { title: best.name })}
                    title={best.name}
                  >
                    {easy ? '▶ Best release' : 'Open best release'}
                  </CatalogLink>
                )}
                <CatalogLink className='button' href={all}>
                  Search all sources
                </CatalogLink>
              </p>
              {best && (
                <p className='meta best-note'>
                  Best release:{' '}
                  {easy
                    ? 'the lowest-effort title that looks playable without re-encoding video'
                    : 'the most seeded one'}{' '}
                  ({count(best.seeders ?? 0, 'seeder')}).
                </p>
              )}
            </>
          )}
        </div>
      </div>
      <Status
        busy={query.isFetching}
        error={query.error}
        retry={() => {
          query.refetch().catch(console.error)
        }}
      >
        {query.isFetching ? 'Finding releases…' : ''}
      </Status>
      <section id='releases' hidden={!t}>
        <h2>{count(releases.length, 'release')}</h2>
        <ul className='releases'>
          {releases.map((r) => (
            <ReleaseRow
              key={r.infoHash}
              item={r}
              href={urls.torrent(r.infoHash, { title: r.name })}
              best={r === best}
            />
          ))}
        </ul>
        <p className='truncated'>
          {t?.truncated && (
            <>
              These are the releases among the 100 most-seeded matches for its name; BitMagnet has more.{' '}
              <CatalogLink href={all}>Search all sources</CatalogLink> for the rest.
            </>
          )}
        </p>
      </section>
    </main>
  )
}
