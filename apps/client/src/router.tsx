// Every page the app has, by URL. The server answers exactly these paths with the shell (apps/server/src/http/static.ts).
import { lazy, Suspense } from 'react'
import type { ReactNode } from 'react'
import { Link, Outlet, createRootRoute, createRoute, createRouter, stripSearchParams, notFound } from '@tanstack/react-router'
import { Settings } from './Settings.tsx'
import { Torrent } from './Torrent.tsx'
import { Search } from './Search.tsx'
import { Explore } from './Explore.tsx'
import { Title } from './Title.tsx'
import { TopBar } from './components/TopBar.tsx'

const rootRoute = createRootRoute({
  component: (): ReactNode => (
    <>
      <TopBar />
      <Outlet />
    </>
  ),
  errorComponent: (): ReactNode => <main><h1>Page unavailable</h1><p>Reload the app to load this page again.</p><button type='button' className='button' onClick={() => location.reload()}>Reload app</button></main>,
  notFoundComponent: (): ReactNode => (
    <main>
      <h1>Not found</h1>
      <p>
        <Link to='/' search={{ q: '', cat: '' }}>Search</Link>
      </p>
    </main>
  ),
})

const exploreTypes = new Set(['movie', 'tv_show', 'music', 'audiobook', 'ebook', 'comic', 'game', 'software', 'xxx', 'unknown'])
const string = (value: unknown): string => (typeof value === 'string' ? value : typeof value === 'number' && Number.isFinite(value) ? String(value) : '')
export const searchRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  validateSearch: (s: Record<string, unknown>) => ({ q: string(s.q), cat: string(s.cat) }),
  search: { middlewares: [stripSearchParams({ q: '', cat: '' })] },
  component: Search,
})
export const exploreRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/explore',
  validateSearch: (s: Record<string, unknown>) => ({
    type: exploreTypes.has(string(s.type)) ? string(s.type) : 'movie',
    sort: s.sort === 'added' ? 'added' : 'seeders',
    genre: string(s.genre),
    year: string(s.year),
    res: string(s.res),
  }),
  search: { middlewares: [stripSearchParams({ type: 'movie', sort: 'seeders', genre: '', year: '', res: '' })] },
  component: Explore,
})
export const titleRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/title/$type/$source/$id',
  validateSearch: (s: Record<string, unknown>) => ({ title: string(s.title), year: string(s.year) }),
  search: { middlewares: [stripSearchParams({ title: '', year: '' })] },
  component: Title,
})
export const torrentRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/t/{-$ih}',
  beforeLoad: ({ params }) => {
    if (params.ih && !/^[a-f0-9]{40}$/.test(params.ih)) {
      throw notFound() // eslint-disable-line @typescript-eslint/only-throw-error -- Router uses a not-found sentinel.
    }
  },
  validateSearch: (s: Record<string, unknown>) => ({ title: string(s.title), link: string(s.link), magnet: string(s.magnet) }),
  search: { middlewares: [stripSearchParams({ title: '', link: '', magnet: '' })] },
  component: Torrent,
})
export const playerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/play/$ih/$idx',
  beforeLoad: ({ params }) => {
    if (!/^[a-f0-9]{40}$/.test(params.ih) || !/^\d+$/.test(params.idx) || !Number.isSafeInteger(Number(params.idx))) throw notFound() // eslint-disable-line @typescript-eslint/only-throw-error -- Router uses a not-found sentinel.
  },
  component: () => { const params = playerRoute.useParams(); return <Suspense fallback={<main><p className='status busy'>Loading player…</p></main>}><LazyPlayer key={`${params.ih}:${params.idx}`} /></Suspense> },
})
const LazyPlayer = lazy(() => import('./Player.tsx').then(module => ({ default: module.Player })))
const settingsRoute = createRoute({ getParentRoute: () => rootRoute, path: '/settings', component: Settings })
const routeTree = rootRoute.addChildren([
  searchRoute,
  exploreRoute,
  titleRoute,
  torrentRoute,
  playerRoute,
  settingsRoute,
])
// Public URLs use ordinary string values, including numeric categories and years.
// Router's default JSON serialization would quote those strings in shared links.
export const router = createRouter({
  routeTree,
  scrollRestoration: true,
  parseSearch: search => Object.fromEntries(new URLSearchParams(search)),
  stringifySearch: search => {
    const query = new URLSearchParams(Object.entries(search).flatMap(([key, value]) =>
      typeof value === 'string' && value !== '' ? [[key, value]] : []
    )).toString()
    return query ? `?${query}` : ''
  },
})
declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
