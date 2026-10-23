// The bar on every page: the name, Explore, the search box, and the status menu with the Settings gear.
import type { FormEvent, ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useRouterState, useSearch } from '@tanstack/react-router'
import { lastSearch, rememberSearch } from '../lib/ui.ts'
import { searchQuery } from '../lib/query.ts'
import { StatusMenu } from './StatusMenu.tsx'

export function TopBar (): ReactNode {
  const pathname = useRouterState({ select: state => state.location.pathname })
  const search = useSearch({ strict: false })
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const home = pathname === '/'
  const q = home ? search.q ?? '' : lastSearch()
  const cat = home ? search.cat ?? '' : ''

  /** A new query is a new history entry, so Back returns to the previous search; the same one asks the sources again. */
  const submit = (e: FormEvent<HTMLFormElement>): void => {
    e.preventDefault()
    const next = (new FormData(e.currentTarget).get('q') as string | null ?? '').trim()
    if (!next) {
      if (!home) navigate({ to: '/' }).catch(console.error)
      return
    }
    rememberSearch(next)
    if (home && next === search.q) queryClient.invalidateQueries({ queryKey: searchQuery(next, cat).queryKey }).catch(console.error)
    else navigate({ to: '/', search: { q: next, ...(cat && { cat }) } }).catch(console.error)
  }

  return (
    <header className='topbar'>
      <Link className='brand' to='/' activeOptions={{ exact: true }}>magplay</Link>
      <Link className='navlink' to='/explore'>Explore</Link>
      <form id={home ? 'search' : undefined} className='topsearch' action='/' role='search' onSubmit={submit}>
        {/* Keyed by the query, so Back to another search shows that query */}
        <input key={q} name='q' type='search' placeholder={home ? 'Search or paste a magnet link…' : 'Search'} aria-label='Search' defaultValue={q} autoFocus={home} required={home} />
        {home && <button>Search</button>}
      </form>
      <StatusMenu />
    </header>
  )
}
