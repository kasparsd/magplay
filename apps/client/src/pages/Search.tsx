// The search page, /?q=…&cat=…: results from every source, each linking to its torrent page. Without a query it is the
// home page: torrents already in the cache, with where this browser left off. The query box is the top bar's.
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useNavigate, useSearch } from '@tanstack/react-router'
import type { RecentTorrent, SourceReport } from '@magplay/api-contract'
import { api } from '../lib/api.ts'
import { searchQuery } from '../lib/query.ts'
import { formatBytes, recall, remember, rememberSearch, timeAgo } from '../lib/ui.ts'
import { urls } from '../lib/urls.ts'
import { ReleaseRow } from '../components/ReleaseRow.tsx'
import { errorText, Status } from '../components/Status.tsx'

const CATEGORIES = [['', 'All'], ['2000', 'Movies'], ['5000', 'TV'], ['3000', 'Audio'], ['4000', 'Software'], ['7000', 'Books'], ['8000', 'Other']] as const

export function SearchPage (): ReactNode {
  const { q = '', cat = '' } = useSearch({ from: '/' })
  const navigate = useNavigate()
  useEffect(() => { document.title = 'magplay' }, [])
  // The header search box keeps the last search on every page
  useEffect(() => { if (q) rememberSearch(q) }, [q])
  const search = useQuery({ ...searchQuery(q, cat), enabled: !!q })
  const retry = (): void => { search.refetch().catch(console.error) }
  const data = search.isFetching ? undefined : search.data
  const items = data?.results ?? []
  return (
    <main>
      <div id='toolbar' className='toolbar' hidden={!q}>
        <div className='seg' role='radiogroup' aria-label='Category'>
          {CATEGORIES.map(([value, label]) => (
            <label key={value}>
              {/* Switching category searches again straight away, replacing the entry rather than adding one */}
              <input type='radio' aria-label={label} name='cat' value={value} checked={cat === value} onChange={() => { navigate({ to: '/', search: { q, ...(value && { cat: value }) }, replace: true }).catch(console.error) }} />
              <span>{label}</span>
            </label>
          ))}
        </div>
        <Status
          busy={search.isFetching}
          text={search.isFetching ? 'Searching…' : data ? (items.length ? `${items.length} result${items.length === 1 ? '' : 's'}` : 'Nothing found.') : ''}
          error={search.isFetching ? null : errorText(search.error)}
          retry={retry}
        />
      </div>
      <Sources sources={data?.sources ?? []} retry={retry} />
      {!q && <Recent />}
      <ul id='results' className='releases' hidden={!items.length}>
        {items.map((item, i) => (
          <ReleaseRow
            key={`${item.infoHash ?? item.linkId ?? ''}-${i}`}
            release={{ ...item, name: item.title }}
            href={urls.torrent(item.infoHash, { title: item.title, link: item.linkId, magnet: item.magnet })}
            note={(data?.sources.length ?? 0) > 1 && item.sources.join(', ')}
          />
        ))}
      </ul>
    </main>
  )
}

/** One chip per answering source with its count (when there is more than one), and a line for each that failed. */
function Sources ({ sources, retry }: { sources: SourceReport[], retry: () => void }): ReactNode {
  const failed = sources.filter(s => !s.ok)
  return (
    <>
      <div id='sources' className='chips'>
        {sources.length > 1 && sources.map(s => s.ok && <span key={s.name} className='chip' title={`${s.count} results in ${(s.ms / 1000).toFixed(1)} s`}>{`${s.name} ${s.count}`}</span>)}
      </div>
      <ul id='source-errors' className='source-errors'>
        {failed.map(s => <li key={s.name}><strong>{s.name}</strong>{`: ${s.error}`}</li>)}
        {failed.length > 0 && <li><button type='button' className='retry' onClick={retry}>Search again</button></li>}
      </ul>
    </>
  )
}

/** `hidden` with `infoHash` hidden as of now. */
const hiding = (hidden: Map<string, number>, infoHash: string): Map<string, number> => new Map(hidden).set(infoHash, Date.now())

/** The home page's list. Removing hides an item in this browser until it is opened again; nothing leaves the cache. */
function Recent (): ReactNode {
  const recent = useQuery({ queryKey: ['recent'], queryFn: ({ signal }) => api<RecentTorrent[]>('/api/recent', { signal }).catch(() => null) })
  const [hidden, setHidden] = useState(() => new Map(Object.entries((recall('hiddenRecent') ?? {}) as Record<string, number>)))
  if (!recent.isSuccess) return <section id='recent' hidden />
  const list = recent.data ?? []
  const shown = list.filter(t => !((hidden.get(t.infoHash) ?? 0) >= t.lastUsed))
  const remove = (t: RecentTorrent): void => {
    const next = hiding(hidden, t.infoHash)
    remember('hiddenRecent', Object.fromEntries([...next].filter(([ih]) => list.some(t => t.infoHash === ih))))
    setHidden(next)
  }
  if (!shown.length) {
    return (
      <section id='recent'>
        <p className='help'>
          Search every configured source for a film, show or anything else with a torrent, paste a magnet link, or <Link to='/explore'>explore what BitMagnet has found</Link>. Torrents you open are listed here.
        </p>
      </section>
    )
  }
  return (
    <section id='recent'>
      <h2>Recently opened</h2>
      <ul>
        {shown.map(t => {
          const name = t.name ?? t.infoHash
          const last = recall(`last:${t.infoHash}`) as { label: string, at: number } | null
          const onServer = t.length ? Math.round((t.onDisk / t.length) * 100) : 0
          return (
            <li key={t.infoHash}>
              <div className='main'>
                <a className='title' href={urls.torrent(t.infoHash, { title: name })}>{name}</a>
                <div className='meta'>
                  {[
                    last && `last played ${last.label}, ${timeAgo(last.at)}`,
                    !last && `opened ${timeAgo(t.lastUsed)}`,
                    `${formatBytes(t.length)}, ${onServer}% on the server`,
                  ].filter(Boolean).join(' · ')}
                </div>
              </div>
              <button type='button' className='remove' title='Remove from this list (the files stay on the server)' aria-label={`Remove ${name} from this list`} onClick={() => { remove(t) }}>✕</button>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
