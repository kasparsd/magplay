// The explore page, /explore?type=&genre=&year=&res=&sort=: films and shows from BitMagnet, one tile per title.
// The filters live in the URL: each change is its own history entry, so Back steps back through them (and then off
// Explore) instead of leaving with every choice lost; reload and shared links keep them too.
import { useEffect } from 'react'
import type { ReactNode } from 'react'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { Link, useNavigate, useSearch } from '@tanstack/react-router'
import type { ExploreFacets, ExploreResponse, ExploreTitle, FacetCount, LatestRelease } from '@magplay/api-contract'
import { api } from '../lib/api.ts'
import { count, timeAgo } from '../lib/ui.ts'
import { urls } from '../lib/urls.ts'
import { Poster } from '../components/Poster.tsx'
import { ReleaseRow } from '../components/ReleaseRow.tsx'
import { errorText, Status } from '../components/Status.tsx'

export interface ExploreSearch { type?: string, sort?: string, genre?: string, year?: string, res?: string }
type Filters = Required<ExploreSearch>

/** The filters a URL asks for. An unknown type falls back to the server's validation. */
const filtersFrom = (s: ExploreSearch): Filters => ({ type: s.type || 'movie', sort: s.sort === 'added' ? 'added' : 'seeders', genre: s.genre ?? '', year: s.year ?? '', res: s.res ?? '' })
/** The URL's search for `f`: the defaults and empty filters are left out. */
const searchFor = (f: Filters): ExploreSearch => Object.fromEntries(Object.entries({ ...f, type: f.type === 'movie' ? '' : f.type, sort: f.sort === 'seeders' ? '' : f.sort }).filter(([, v]) => v))
const apiQuery = (f: Filters, page: number): URLSearchParams => new URLSearchParams({ ...Object.fromEntries(Object.entries(f).filter(([, v]) => v)), page: String(page) })

const TYPES = [
  ['Video', [['movie', 'Movies'], ['tv_show', 'TV shows']]],
  ['Audio', [['music', 'Music'], ['audiobook', 'Audiobooks']]],
  ['Reading', [['ebook', 'Books'], ['comic', 'Comics']]],
  ['Software', [['game', 'Games'], ['software', 'Software']]],
  ['Other', [['xxx', 'Adult'], ['unknown', 'Uncategorized']]],
] as const
const RESOLUTIONS: Record<string, string> = { V2160p: '4K', V1440p: '1440p', V1080p: '1080p', V720p: '720p', V576p: '576p', V480p: '480p' }
const TOP_GENRES = 14

// BitMagnet's estimated counts can be 100× off (film genres), so only exact ones are shown
const exact = (o: FacetCount): string => o.estimate || o.count == null ? '' : o.count.toLocaleString()
const optionLabel = (label: string, o: FacetCount): string => exact(o) ? `${label} (${exact(o)})` : label

export function ExplorePage (): ReactNode {
  const filters = filtersFrom(useSearch({ from: '/explore' }))
  const navigate = useNavigate()
  useEffect(() => { document.title = 'Explore · magplay' }, [])

  /** Changes filters. Genres differ between films and shows, so a new type starts without genre, year or quality. */
  const apply = (changes: Partial<Filters>): void => {
    const typeChanged = changes.type !== undefined && changes.type !== filters.type
    const next = { ...filters, ...changes, ...(typeChanged && { genre: '', year: '', res: '' }) }
    navigate({ to: '/explore', search: searchFor(next) }).catch(console.error)
  }

  const titles = useInfiniteQuery({
    queryKey: ['explore', filters],
    queryFn: ({ pageParam, signal }) => api<ExploreResponse>(`/api/explore?${apiQuery(filters, pageParam)}`, { signal }),
    initialPageParam: 1,
    getNextPageParam: (last, pages) => last.hasMore ? pages.length + 1 : undefined,
  })
  // Pages can repeat a title the previous page had; it is shown once
  const seen = new Set<string>()
  const tiles = (titles.data?.pages ?? []).flatMap(p => p.titles).filter(t => !seen.has(`${t.source}:${t.id}`) && !!seen.add(`${t.source}:${t.id}`))
  const failed = titles.isFetchNextPageError || (titles.isError && !titles.data)
  const retry = (): void => { (titles.isFetchNextPageError ? titles.fetchNextPage() : titles.refetch()).catch(console.error) }

  return (
    <main>
      <form id='filters' className='toolbar' onSubmit={e => { e.preventDefault() }}>
        <select name='type' aria-label='Type' value={filters.type} onChange={e => { apply({ type: e.target.value }) }}>
          {TYPES.map(([group, options]) => (
            <optgroup key={group} label={group}>
              {options.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </optgroup>
          ))}
        </select>
        <div className='seg' role='radiogroup' aria-label='Sort'>
          {([['seeders', 'Most seeded'], ['added', 'Newest']] as const).map(([value, label]) => (
            <label key={value}>
              <input type='radio' aria-label={label} name='sort' value={value} checked={filters.sort === value} onChange={() => { apply({ sort: value }) }} />
              <span>{label}</span>
            </label>
          ))}
        </div>
        <Facets filters={filters} apply={apply} />
      </form>
      <Genres filters={filters} apply={apply} />
      <Status
        busy={titles.isFetching && !failed}
        text={titles.isFetchingNextPage ? 'Loading more…' : titles.isPending ? 'Loading…' : tiles.length ? '' : 'Nothing matches these filters.'}
        error={failed ? errorText(titles.error) : null}
        retry={retry}
      />
      <div id='tiles' className='tiles'>{tiles.map(t => <Tile key={`${t.source}:${t.id}`} title={t} />)}</div>
      <p className='actions'>
        <button id='more' type='button' className='button' hidden={!titles.hasNextPage || titles.isFetching || failed} onClick={() => { titles.fetchNextPage().catch(console.error) }}>Show more</button>
      </p>
      <Latest type={filters.type} />
    </main>
  )
}

function Tile ({ title: t }: { title: ExploreTitle }): ReactNode {
  return (
    <Link className='tile' to='/title/$type/$source/$id' params={{ type: t.type, source: t.source, id: t.id }} search={{ title: t.title, ...(t.year && { year: String(t.year) }) }}>
      <Poster title={t.title} />
      <div className='info'>
        <div className='sr-only'>{t.title}</div>{/* the tile shows it; this names the link for screen readers */}
        <div className='meta'>{[t.year, t.rating && `★ ${t.rating}`].filter(Boolean).join(' · ')}</div>
        {t.genres.length > 0 && <div className='meta'>{t.genres.slice(0, 2).join(', ')}</div>}
        <div className='badges'>
          {t.playable && <span className='badge good'>plays in browser</span>}
          {t.seeders != null && <span className='badge'>{count(t.seeders, 'seeder')}</span>}
        </div>
      </div>
    </Link>
  )
}

/** BitMagnet's counts for the current filters. They can take a while, so the tiles don't wait for them. */
function useFacets (filters: Filters) {
  return useQuery({
    queryKey: ['explore-facets', filters],
    queryFn: ({ signal }) => api<ExploreFacets>(`/api/explore/facets?${apiQuery(filters, 1)}`, { signal }),
    // While new counts load, the last ones stay, unless the type changed: its genres are different
    placeholderData: (previous, query) => (query?.queryKey[1] as Filters | undefined)?.type === filters.type ? previous : undefined,
    staleTime: 5 * 60_000,
  })
}

/** Year and quality, with BitMagnet's counts. Until they arrive, a chosen value is a lone option. */
function Facets ({ filters, apply }: { filters: Filters, apply: (changes: Partial<Filters>) => void }): ReactNode {
  const { data } = useFacets(filters)
  const order = Object.keys(RESOLUTIONS) // highest first
  const years = (data?.years ?? []).slice(0, 40).map(y => ({ value: String(y.value), label: optionLabel(String(y.value), y) }))
  const resolutions = (data?.resolutions ?? []).filter(r => RESOLUTIONS[String(r.value)])
    .sort((a, b) => order.indexOf(String(a.value)) - order.indexOf(String(b.value)))
    .map(r => ({ value: String(r.value), label: optionLabel(RESOLUTIONS[String(r.value)]!, r) }))
  const select = (name: 'year' | 'res', label: string, any: string, options: Array<{ value: string, label: string }>): ReactNode => {
    const current = filters[name]
    const all = current && !options.some(o => o.value === current) ? [{ value: current, label: current }, ...options] : options
    return (
      <select name={name} aria-label={label} value={current} onChange={e => { apply({ [name]: e.target.value }) }}>
        <option value=''>{any}</option>
        {all.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    )
  }
  return <>{select('year', 'Year', 'Any year', years)}{select('res', 'Quality', 'Any quality', resolutions)}</>
}

/** Genre chips. The chosen genre always has one, even when it isn't among the most common ones. */
function Genres ({ filters, apply }: { filters: Filters, apply: (changes: Partial<Filters>) => void }): ReactNode {
  const facets = useFacets(filters)
  if (!facets.data) {
    return (
      <div id='genres' className='chips' role='group' aria-label='Genre'>
        {facets.isError && !facets.isFetching
          ? <><span className='muted'>Genre counts didn't arrive in time.</span><button type='button' className='chip' onClick={() => { facets.refetch().catch(console.error) }}>Try again</button></>
          : <span className='chip'>Counting genres…</span>}
      </div>
    )
  }
  const genres = facets.data.genres
  const top = genres.slice(0, TOP_GENRES)
  const chosen = filters.genre && !top.some(g => g.value === filters.genre) && (genres.find(g => g.value === filters.genre) ?? { value: filters.genre, label: filters.genre, count: 0, estimate: true as const })
  const chip = (label: string, value: string): ReactNode => (
    <button key={value} type='button' className={`chip${filters.genre === value ? ' on' : ''}`} aria-pressed={filters.genre === value} onClick={() => { apply({ genre: value }) }}>{label}</button>
  )
  return (
    <div id='genres' className='chips' role='group' aria-label='Genre'>
      {chip('All genres', '')}
      {[...top, ...(chosen ? [chosen] : [])].map(g => chip(exact(g) ? `${g.label ?? g.value} ${exact(g)}` : String(g.label ?? g.value), String(g.value)))}
    </div>
  )
}

/** The newest releases of this type, matched to a title where BitMagnet could. */
function Latest ({ type }: { type: string }): ReactNode {
  const { data: list = [] } = useQuery({
    queryKey: ['explore-latest', type],
    queryFn: ({ signal }) => api<LatestRelease[]>(`/api/explore/latest?type=${type}`, { signal }).catch(() => []),
  })
  return (
    <section id='latest' hidden={!list.length}>
      <h2>Just added</h2>
      <ul className='releases'>
        {list.map(r => (
          <ReleaseRow
            key={r.infoHash}
            // Matched releases read as "Show · S02E05"; unmatched ones keep their release name
            release={{ ...r, name: r.title ? [r.title.title, r.episode].filter(Boolean).join(' · ') : r.name, episode: null }}
            href={urls.torrent(r.infoHash, { title: r.name })}
            meta={[r.publishedAt && timeAgo(Date.parse(r.publishedAt))]}
          />
        ))}
      </ul>
    </section>
  )
}
