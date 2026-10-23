// A page not yet rewritten as components: its markup, then its script, which finds its elements by id as before.
// A module runs once per document, so leaving such a page, or opening another, is a full page load (see leaveVanilla).
import { useEffect } from 'react'
import type { ReactNode } from 'react'
import search from '../pages/search.html?raw'
import explore from '../pages/explore.html?raw'
import title from '../pages/title.html?raw'
import torrent from '../pages/torrent.html?raw'
import player from '../pages/player.html?raw'
import settings from '../pages/settings.html?raw'

interface Page { html: string, title: string, bodyClass?: string, load: () => Promise<unknown> }

export const PAGES = {
  search: { html: search, title: 'magplay', load: () => import('../search.js') },
  explore: { html: explore, title: 'Explore · magplay', load: () => import('../explore.js') },
  title: { html: title, title: 'magplay', load: () => import('../title.ts') },
  torrent: { html: torrent, title: 'magplay', load: () => import('../torrent.ts') },
  player: { html: player, title: 'magplay', bodyClass: 'player-page', load: () => import('../player.ts') },
  settings: { html: settings, title: 'Settings · magplay', load: () => import('../settings.ts') },
} satisfies Record<string, Page>

/** The path of the vanilla page this document is showing, if any. */
let shown: string | null = null

/**
 * Before any navigation: away from a vanilla page, the browser loads the new URL itself, since the page's script
 * keeps running and can't be started again. Back and Forward within the page (its own pushState) stay with it.
 */
export function leaveVanilla (pathname: string, href: string): Promise<never> | undefined {
  if (shown === null || pathname === shown) return
  location.assign(href)
  return new Promise(() => {}) // the page is going away
}

export function VanillaPage ({ page }: { page: keyof typeof PAGES }): ReactNode {
  const { html, load, ...rest } = PAGES[page] as Page
  useEffect(() => {
    shown = location.pathname
    document.title = rest.title
    if (rest.bodyClass) document.body.classList.add(rest.bodyClass)
    load().catch(console.error)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps -- once: the script owns the page from here
  return <div className='vanilla-page' dangerouslySetInnerHTML={{ __html: html }} />
}
