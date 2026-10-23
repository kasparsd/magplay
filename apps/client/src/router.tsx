// Every page the app has, by URL. The server answers exactly these paths with the shell (apps/server/src/http/static.ts).
import type { ReactNode } from 'react'
import { Outlet, createRootRoute, createRoute, createRouter } from '@tanstack/react-router'
import { TopBar } from './components/TopBar.tsx'
import { leaveVanilla, VanillaPage } from './components/VanillaPage.tsx'

const rootRoute = createRootRoute({
  beforeLoad: ({ location }) => leaveVanilla(location.pathname, location.href),
  component: (): ReactNode => <><TopBar /><Outlet /></>,
  notFoundComponent: (): ReactNode => <main><h1>Not found</h1><p><a href='/'>Search</a></p></main>,
})

const page = <Path extends string>(path: Path, name: Parameters<typeof VanillaPage>[0]['page']) =>
  createRoute({ getParentRoute: () => rootRoute, path, component: () => <VanillaPage page={name} /> })

const routeTree = rootRoute.addChildren([
  page('/', 'search'),
  page('/explore', 'explore'),
  page('/title/$type/$source/$id', 'title'),
  page('/t/{-$ih}', 'torrent'),
  page('/play/$ih/$idx', 'player'),
  page('/settings', 'settings'),
])

export const router = createRouter({ routeTree })

declare module '@tanstack/react-router' {
  interface Register { router: typeof router }
}
