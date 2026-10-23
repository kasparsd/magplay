// Every page the app has, by URL. The server answers exactly these paths with the shell (apps/server/src/http/static.ts).
import type { ReactNode } from 'react'
import { Outlet, createRootRoute, createRoute, createRouter, stripSearchParams } from '@tanstack/react-router'
import { Settings } from './Settings.tsx'
import { Torrent } from './Torrent.tsx'
import { Search } from './Search.tsx'
import { Explore } from './Explore.tsx'
import { Title } from './Title.tsx'
import { TopBar } from './components/TopBar.tsx'
import { leaveVanilla, VanillaPage } from './components/VanillaPage.tsx'

const rootRoute = createRootRoute({
  beforeLoad: ({ location }) => leaveVanilla(location.pathname, location.href),
  component: (): ReactNode => (
    <>
      <TopBar />
      <Outlet />
    </>
  ),
  notFoundComponent: (): ReactNode => (
    <main>
      <h1>Not found</h1>
      <p>
        <a href='/'>Search</a>
      </p>
    </main>
  ),
})

const page = <Path extends string>(path: Path, name: Parameters<typeof VanillaPage>[0]['page']) =>
  createRoute({ getParentRoute: () => rootRoute, path, component: () => <VanillaPage page={name} /> })

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
  validateSearch: (s: Record<string, unknown>) => ({ title: string(s.title), link: string(s.link), magnet: string(s.magnet) }),
  search: { middlewares: [stripSearchParams({ title: '', link: '', magnet: '' })] },
  component: Torrent,
})
const settingsRoute = createRoute({ getParentRoute: () => rootRoute, path: '/settings', component: Settings })
const routeTree = rootRoute.addChildren([
  searchRoute,
  exploreRoute,
  titleRoute,
  torrentRoute,
  page('/play/$ih/$idx', 'player'),
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
