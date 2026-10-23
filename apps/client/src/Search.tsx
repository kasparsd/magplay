import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { RecentTorrent, SearchResponse } from '@magplay/api-contract'
import { searchRoute } from './router.tsx'
import { api } from './lib/api.ts'
import { recall, remember, formatBytes, timeAgo } from './lib/ui.ts'
import { urls } from './lib/urls.ts'
import { CatalogLink, ReleaseRow, Status } from './components/Catalog.tsx'

export function Search (): ReactNode {
  useEffect(() => { document.title = 'magplay' }, [])
  const { q, cat } = searchRoute.useSearch()
  const navigate = searchRoute.useNavigate()
  const search = useQuery({
    queryKey: ['search', q, cat],
    queryFn: ({ signal }) =>
      api<SearchResponse>(`/api/search?${new URLSearchParams({ q, cat })}`, { signal }),
    enabled: !!q,
    staleTime: 180_000,
  })
  const recent = useQuery({
    queryKey: ['recent'],
    queryFn: ({ signal }) => api<RecentTorrent[]>('/api/recent', { signal }),
    enabled: !q,
  })
  const [hidden, setHidden] = useState<Record<string, number>>(
    () => (recall('hiddenRecent') ?? {}) as Record<string, number>
  )
  const shown = (recent.data ?? []).filter((t) => !(hidden[t.infoHash]! >= t.lastUsed))
  const data = search.data
  return (
    <main>
      <div id='toolbar' className='toolbar' hidden={!q}>
        <div className='seg' role='radiogroup' aria-label='Category'>
          {[
            ['', 'All'],
            ['2000', 'Movies'],
            ['5000', 'TV'],
            ['3000', 'Audio'],
            ['4000', 'Software'],
            ['7000', 'Books'],
            ['8000', 'Other'],
          ].map(([value, label]) => (
            <label key={value}>
              <input
                type='radio'
                aria-label={label}
                name='cat'
                value={value}
                form='search'
                checked={cat === value}
                onChange={() => {
                  navigate({ search: { q, cat: value! }, replace: true }).catch(console.error)
                }}
              />
              <span>{label}</span>
            </label>
          ))}
        </div>
        <Status
          busy={search.isFetching}
          error={search.error}
          retry={() => {
            search.refetch().catch(console.error)
          }}
        >
          {search.isFetching
            ? 'Searching…'
            : data?.results.length
              ? `${data.results.length} result${data.results.length === 1 ? '' : 's'}`
              : 'Nothing found.'}
        </Status>
      </div>
      <div id='sources' className='chips'>
        {data &&
          q &&
          data.sources.length > 1 &&
          data.sources.map(
            (s) =>
              s.ok && (
                <span
                  className='chip'
                  key={s.name}
                  title={`${s.count} results in ${(s.ms / 1000).toFixed(1)} s`}
                >
                  {s.name} {s.count}
                </span>
              )
          )}
      </div>
      <ul id='source-errors' className='source-errors'>
        {q &&
          data?.sources.map(
            (s) =>
              !s.ok && (
                <li key={s.name}>
                  <strong>{s.name}</strong>: {s.error}
                </li>
              )
          )}
        {q && data?.sources.some((s) => !s.ok) && (
          <li>
            <button
              className='retry'
              onClick={() => {
                search.refetch().catch(console.error)
              }}
            >
              Search again
            </button>
          </li>
        )}
      </ul>
      <section id='recent' hidden={!!q}>
        {shown.length
          ? (
              <>
                <h2>Recently opened</h2>
                <ul>
                  {shown.map((t) => {
                    const last = recall(`last:${t.infoHash}`) as { label: string; at: number } | null
                    return (
                      <li key={t.infoHash}>
                        <div className='main'>
                          <CatalogLink className='title' href={urls.torrent(t.infoHash, { title: t.name })}>
                            {t.name}
                          </CatalogLink>
                          <div className='meta'>
                            {[
                              last
                                ? `last played ${last.label}, ${timeAgo(last.at)}`
                                : `opened ${timeAgo(t.lastUsed)}`,
                          `${formatBytes(t.length)}, ${t.length ? Math.round((t.onDisk / t.length) * 100) : 0}% on the server`,
                            ].join(' · ')}
                          </div>
                        </div>
                        <button
                          type='button'
                          className='remove'
                          title='Remove from this list (the files stay on the server)'
                          aria-label={`Remove ${t.name} from this list`}
                          onClick={() => {
                            const next = { ...hidden, [t.infoHash]: Date.now() }
                            setHidden(next)
                            remember('hiddenRecent', next)
                          }}
                        >
                          ✕
                        </button>
                      </li>
                    )
                  })}
                </ul>
              </>
            )
          : (
              <p className='help'>
                Search every configured source for a film, show or anything else with a torrent, paste a magnet
                link, or <CatalogLink href='/explore'>explore what BitMagnet has found</CatalogLink>. Torrents you
                open are listed here.
              </p>
            )}
      </section>
      <ul id='results' className='releases' hidden={!q || !data?.results.length}>
        {q &&
          data?.results.map((r, i) => (
            <ReleaseRow
              key={`${r.infoHash ?? r.linkId}:${i}`}
              item={{ ...r, name: r.title }}
              href={urls.torrent(r.infoHash, { title: r.title, link: r.linkId, magnet: r.magnet })}
              note={data.sources.length > 1 && r.sources.join(', ')}
            />
          ))}
      </ul>
    </main>
  )
}
