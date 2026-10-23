// The bar on every page: the name, Explore, the search box, and the status menu with the Settings gear.
import { useState } from 'react'
import type { ReactNode } from 'react'
import { Link, useRouterState, useNavigate } from '@tanstack/react-router'
import { queryClient } from '../lib/query.ts'
import { StatusMenu } from './StatusMenu.tsx'

export function TopBar (): ReactNode {
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const navigate = useNavigate()
  const q = useRouterState({ select: (state) => (state.location.search as { q?: string }).q ?? state.location.state.catalogQuery ?? '' })
  const cat = useRouterState({ select: state => (state.location.search as { cat?: string }).cat ?? '' })
  const home = pathname === '/'
  const [previousQuery, setPreviousQuery] = useState(q)
  const [draft, setDraft] = useState(q)
  if (previousQuery !== q) {
    setPreviousQuery(q)
    setDraft(q)
  }
  return (
    <header className='topbar'>
      <Link className='brand' to='/' search={{ q: '', cat: '' }} activeOptions={{ exact: true }}>
        magplay
      </Link>
      <Link
        className='navlink'
        state={{ catalogQuery: q }}
        to='/explore'
        search={{ type: 'movie', sort: 'seeders', genre: '', year: '', res: '' }}
      >
        Explore
      </Link>
      {/* On the search page it is that page's form (its category filter belongs to it, form="search"), filled from the URL */}
      <form
        id={home ? 'search' : undefined}
        className='topsearch'
        action='/'
        role='search'
        onSubmit={(e) => {
          e.preventDefault()
          const data = new FormData(e.currentTarget)
          const value = ((data.get('q') as string | null) ?? '').trim()
          const category = (data.get('cat') as string | null) ?? ''
          if (home && value === q && category === cat) {
            queryClient.refetchQueries({ queryKey: ['search', q, cat], exact: true }).catch(console.error)
          } else if (value) {
            navigate({ to: '/', search: { q: value, cat: category } }).catch(
              console.error
            )
          }
        }}
      >
        <input
          name='q'
          type='search'
          placeholder={home ? 'Search or paste a magnet link…' : 'Search'}
          aria-label='Search'
          value={draft}
          onChange={e => setDraft(e.target.value)}
          required={home}
        />
        {home && <button>Search</button>}
      </form>
      <StatusMenu />
    </header>
  )
}
