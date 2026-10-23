// Every page the app has, by URL. The server answers exactly these paths with the shell (apps/server/src/http/static.ts).
import type { ReactNode } from 'react'
import { Outlet, createRootRoute, createRoute, createRouter } from '@tanstack/react-router'
import { TopBar } from './components/TopBar.tsx'
import { leaveVanilla, VanillaPage } from './components/VanillaPage.tsx'
import { recordNavigation } from './lib/came-from.ts'
import { ExplorePage } from './pages/Explore.tsx'
import type { ExploreSearch } from './pages/Explore.tsx'
import { SearchPage } from './pages/Search.tsx'
import { TitlePage } from './pages/Title.tsx'
import type { TitleSearch } from './pages/Title.tsx'

/** A URL's query as plain strings: only the keys a page reads, and only non-empty ones. */
const strings = <K extends string>(...keys: K[]) => (search: Record<string, unknown>): Partial<Record<K, string>> =>
  Object.fromEntries(keys.flatMap(key => typeof search[key] === 'string' && search[key] ? [[key, search[key]]] : [])) as Partial<Record<K, string>>

const rootRoute = createRootRoute({
  beforeLoad: ({ location }) => leaveVanilla(location.pathname, location.href),
  component: (): ReactNode => <><TopBar /><Outlet /></>,
  notFoundComponent: (): ReactNode => <main><h1>Not found</h1><p><a href='/'>Search</a></p></main>,
})

const vanilla = <Path extends string>(path: Path, name: Parameters<typeof VanillaPage>[0]['page']) =>
  createRoute({ getParentRoute: () => rootRoute, path, component: () => <VanillaPage page={name} /> })

const searchRoute = createRoute({ getParentRoute: () => rootRoute, path: '/', validateSearch: strings('q', 'cat'), component: SearchPage })
const exploreRoute = createRoute({ getParentRoute: () => rootRoute, path: '/explore', validateSearch: strings<keyof ExploreSearch>('type', 'sort', 'genre', 'year', 'res'), component: ExplorePage })
const titleRoute = createRoute({ getParentRoute: () => rootRoute, path: '/title/$type/$source/$id', validateSearch: strings<keyof TitleSearch>('title', 'year'), component: TitlePage })

const routeTree = rootRoute.addChildren([
  searchRoute,
  exploreRoute,
  titleRoute,
  vanilla('/t/{-$ih}', 'torrent'),
  vanilla('/play/$ih/$idx', 'player'),
  vanilla('/settings', 'settings'),
])

export const router = createRouter({
  routeTree,
  // Query strings stay as they always were (?year=2010, not JSON), so links, bookmarks and the server agree
  parseSearch: search => Object.fromEntries(new URLSearchParams(search)),
  stringifySearch: search => {
    const query = new URLSearchParams(Object.entries(search).flatMap(([key, value]) => value != null && value !== '' ? [[key, String(value)]] : []))
    return query.size ? `?${query}` : ''
  },
  // Back and Forward return to where the page was scrolled
  scrollRestoration: true,
})

router.subscribe('onBeforeNavigate', ({ fromLocation, hrefChanged }) => { if (fromLocation && hrefChanged) recordNavigation(fromLocation.href) })

declare module '@tanstack/react-router' {
  interface Register { router: typeof router }
}
