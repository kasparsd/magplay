// The bar on every page: the name, Explore, the search box, and the status menu with the Settings gear.
import type { ReactNode } from 'react'
import { Link, useRouterState } from '@tanstack/react-router'
import { lastSearch } from '../lib/ui.ts'
import { StatusMenu } from './StatusMenu.tsx'

export function TopBar (): ReactNode {
  const pathname = useRouterState({ select: state => state.location.pathname })
  const home = pathname === '/'
  return (
    <header className='topbar'>
      <Link className='brand' to='/' activeOptions={{ exact: true }}>magplay</Link>
      <Link className='navlink' to='/explore'>Explore</Link>
      {/* On the search page it is that page's form (its category filter belongs to it, form="search"), filled from the URL */}
      <form key={home ? 'home' : 'other'} id={home ? 'search' : undefined} className='topsearch' action='/' role='search'>
        <input name='q' type='search' placeholder={home ? 'Search or paste a magnet link…' : 'Search'} aria-label='Search' defaultValue={home ? '' : lastSearch()} autoFocus={home} required={home} />
        {home && <button>Search</button>}
      </form>
      <StatusMenu />
    </header>
  )
}
