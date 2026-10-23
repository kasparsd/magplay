import { useEffect } from 'react'
import type { ReactNode } from 'react'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import type { ExploreResponse, ExploreFacets, LatestRelease, FacetCount } from '@magplay/api-contract'
import { exploreRoute } from './router.tsx'
import { api } from './lib/api.ts'
import { count, timeAgo } from './lib/ui.ts'
import { urls } from './lib/urls.ts'
import { CatalogLink, Poster, ReleaseRow, Status } from './components/Catalog.tsx'

const resolutions: Record<string, string> = {
  V2160p: '4K',
  V1440p: '1440p',
  V1080p: '1080p',
  V720p: '720p',
  V576p: '576p',
  V480p: '480p',
}
const exact = (o: FacetCount): string => (o.estimate || o.count == null ? '' : o.count.toLocaleString())
export function Explore (): ReactNode {
  useEffect(() => { document.title = 'Explore · magplay' }, [])
  const filters = exploreRoute.useSearch()
  const navigate = exploreRoute.useNavigate()
  const params = new URLSearchParams(filters).toString()
  const apply = (changes: Partial<typeof filters>): void => {
    navigate({
      search: {
        ...filters,
        ...(changes.type && changes.type !== filters.type ? { genre: '', year: '', res: '' } : {}),
        ...changes,
      },
    }).catch(console.error)
  }
  const titles = useInfiniteQuery({
    queryKey: ['explore', filters],
    queryFn: ({ signal, pageParam }) =>
      api<ExploreResponse>(`/api/explore?${params}&page=${pageParam}`, { signal }),
    initialPageParam: 1,
    getNextPageParam: (last, pages) => (last.hasMore ? pages.length + 1 : undefined),
    staleTime: 180_000,
  })
  const facets = useQuery({
    queryKey: ['facets', filters],
    queryFn: ({ signal }) => api<ExploreFacets>(`/api/explore/facets?${params}`, { signal }),
    staleTime: 180_000,
  })
  const latest = useQuery({
    queryKey: ['latest', filters.type],
    queryFn: ({ signal }) => api<LatestRelease[]>(`/api/explore/latest?type=${filters.type}`, { signal }),
    staleTime: 180_000,
  })
  const tiles = [
    ...new Map(titles.data?.pages.flatMap((p) => p.titles).map((t) => [`${t.source}:${t.id}`, t])).values(),
  ]
  const genres = facets.data?.genres.slice(0, 14) ?? []
  if (filters.genre && !genres.some((g) => g.value === filters.genre)) {
    genres.push(
      facets.data?.genres.find((g) => g.value === filters.genre) ?? {
        value: filters.genre,
        label: filters.genre,
        count: 0,
        estimate: true,
      }
    )
  }
  const options = (name: 'year' | 'res', items: FacetCount[]): ReactNode => (
    <select
      name={name}
      aria-label={name === 'year' ? 'Year' : 'Quality'}
      value={filters[name]}
      onChange={(e) => apply({ [name]: e.target.value })}
    >
      <option value=''>{name === 'year' ? 'Any year' : 'Any quality'}</option>
      {filters[name] && !items.some((o) => String(o.value) === filters[name]) && (
        <option>{filters[name]}</option>
      )}
      {items.map((o) => (
        <option key={String(o.value)} value={String(o.value)}>
          {resolutions[String(o.value)] ?? o.value}
          {exact(o) && ` (${exact(o)})`}
        </option>
      ))}
    </select>
  )
  return (
    <main>
      <form id='filters' className='toolbar' onSubmit={(e) => e.preventDefault()}>
        <select
          name='type'
          aria-label='Type'
          value={filters.type}
          onChange={(e) => apply({ type: e.target.value })}
        >
          {[
            [
              'Video',
              [
                ['movie', 'Movies'],
                ['tv_show', 'TV shows'],
              ],
            ],
            [
              'Audio',
              [
                ['music', 'Music'],
                ['audiobook', 'Audiobooks'],
              ],
            ],
            [
              'Reading',
              [
                ['ebook', 'Books'],
                ['comic', 'Comics'],
              ],
            ],
            [
              'Software',
              [
                ['game', 'Games'],
                ['software', 'Software'],
              ],
            ],
            [
              'Other',
              [
                ['xxx', 'Adult'],
                ['unknown', 'Uncategorized'],
              ],
            ],
          ].map(([group, entries]) => (
            <optgroup label={group as string} key={group as string}>
              {(entries as string[][]).map(([value, label]) => (
                <option value={value} key={value}>
                  {label}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        <div className='seg' role='radiogroup' aria-label='Sort'>
          {[
            ['seeders', 'Most seeded'],
            ['added', 'Newest'],
          ].map(([value, label]) => (
            <label key={value}>
              <input
                type='radio'
                name='sort'
                aria-label={label}
                value={value}
                checked={filters.sort === value}
                onChange={() => apply({ sort: value! })}
              />
              <span>{label}</span>
            </label>
          ))}
        </div>
        {options('year', facets.data?.years.slice(0, 40) ?? [])}
        {options(
          'res',
          (facets.data?.resolutions ?? [])
            .filter((r) => resolutions[String(r.value)])
            .toSorted(
              (a, b) =>
                Object.keys(resolutions).indexOf(String(a.value)) -
                Object.keys(resolutions).indexOf(String(b.value))
            )
        )}
      </form>
      <div id='genres' className='chips' role='group' aria-label='Genre'>
        {facets.isPending
          ? (
              <span className='chip'>Counting genres…</span>
            )
          : facets.error
            ? (
                <>
                  <span className='muted'>Genre counts didn't arrive in time.</span>
                  <button
                    className='chip'
                    onClick={() => {
                      facets.refetch().catch(console.error)
                    }}
                  >
                    Try again
                  </button>
                </>
              )
            : (
                <>
                  {[{ value: '', label: 'All genres', count: 0, estimate: true as const }, ...genres].map((g) => (
                    <button
                      type='button'
                      key={String(g.value)}
                      className={`chip${filters.genre === g.value ? ' on' : ''}`}
                      aria-pressed={filters.genre === g.value}
                      onClick={() => apply({ genre: String(g.value ?? '') })}
                    >
                      {g.label}
                      {exact(g) && ` ${exact(g)}`}
                    </button>
                  ))}
                </>
              )}
      </div>
      <Status
        busy={titles.isFetching}
        error={titles.error}
        retry={() => {
          ;(titles.isFetchNextPageError ? titles.fetchNextPage() : titles.refetch()).catch(console.error)
        }}
      >
        {titles.isFetching
          ? titles.isFetchingNextPage
            ? 'Loading more…'
            : 'Loading…'
          : tiles.length
            ? ''
            : 'Nothing matches these filters.'}
      </Status>
      <div id='tiles' className='tiles'>
        {tiles.map((t) => (
          <CatalogLink key={`${t.source}:${t.id}`} className='tile' href={urls.title(t)}>
            <Poster title={t.title} />
            <div className='info'>
              <div className='sr-only'>{t.title}</div>
              <div className='meta'>{[t.year, t.rating && `★ ${t.rating}`].filter(Boolean).join(' · ')}</div>
              {t.genres.length > 0 && <div className='meta'>{t.genres.slice(0, 2).join(', ')}</div>}
              <div className='badges'>
                {t.playable && <span className='badge good'>plays in browser</span>}
                {t.seeders != null && <span className='badge'>{count(t.seeders, 'seeder')}</span>}
              </div>
            </div>
          </CatalogLink>
        ))}
      </div>
      <p className='actions'>
        <button
          id='more'
          type='button'
          className='button'
          hidden={!titles.hasNextPage || titles.isFetching}
          onClick={() => {
            titles.fetchNextPage().catch(console.error)
          }}
        >
          Show more
        </button>
      </p>
      <section id='latest' hidden={!latest.data?.length}>
        <h2>Just added</h2>
        <ul className='releases'>
          {latest.data?.map((r) => (
            <ReleaseRow
              key={r.infoHash}
              item={{
                ...r,
                name: r.title ? [r.title.title, r.episode].filter(Boolean).join(' · ') : r.name,
                episode: null,
              }}
              href={urls.torrent(r.infoHash, { title: r.name })}
              meta={[r.publishedAt && timeAgo(Date.parse(r.publishedAt))]}
            />
          ))}
        </ul>
      </section>
    </main>
  )
}
