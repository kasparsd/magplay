// Where a page's "←" link goes: back to the page the user came from, named for what it shows.

export interface BackTarget {
  label: string
  href: string
  /** The referrer is the previous history entry: go Back, which keeps its scroll position and results. */
  history: boolean
}

/**
 * The back link for a page reached from `referrer` (document.referrer). Only pages of this app count, and only ones
 * worth going back to: search results, Explore, a title, the recently opened list. Otherwise `fallback`, which may be
 * null for no back link at all.
 */
export function backTarget (referrer: string, origin: string, fallback: Omit<BackTarget, 'history'> | null = null): BackTarget | null {
  const from = referrer.startsWith(`${origin}/`) ? new URL(referrer) : null
  const label = from && labelFor(from)
  if (from && label) return { label, href: from.pathname + from.search, history: true }
  return fallback && { ...fallback, history: false }
}

function labelFor ({ pathname, searchParams }: URL): string | null {
  if (pathname === '/') return searchParams.get('q') ? '← Results' : '← Recently opened'
  if (pathname === '/explore') return '← Explore'
  if (pathname.startsWith('/title/')) return `← ${searchParams.get('title') || 'Title'}`
  return null
}

/** Where returnTarget() remembers each page's catalog origin: per tab, like history. */
export interface ReturnStore {
  get: (page: string) => Omit<BackTarget, 'history'> | null
  set: (page: string, target: Omit<BackTarget, 'history'>) => void
}

/** sessionStorage under "magplay:return:<page>"; blocked storage remembers nothing. */
export function sessionReturns (storage: Storage | undefined = globalThis.sessionStorage): ReturnStore {
  const key = (page: string): string => `magplay:return:${page}`
  return {
    get: page => {
      try {
        const value = JSON.parse(storage?.getItem(key(page)) ?? 'null') as unknown
        return value && typeof value === 'object' && 'label' in value && 'href' in value && typeof value.label === 'string' && typeof value.href === 'string' && value.href.startsWith('/')
          ? { label: value.label, href: value.href }
          : null
      } catch { return null }
    },
    set: (page, { label, href }) => { try { storage?.setItem(key(page), JSON.stringify({ label, href })) } catch {} },
  }
}

/**
 * The back link for `page` (its pathname). Reached from a catalog page, it goes Back there and remembers it.
 * Reached again from deeper in the app (the Player, a torrent page), it links to that remembered page by URL,
 * since Back would only return to where the user just was. Otherwise `fallback`.
 */
export function returnTarget (page: string, referrer: string, origin: string, store: ReturnStore, fallback: Omit<BackTarget, 'history'> | null = null): BackTarget | null {
  const direct = backTarget(referrer, origin)
  if (direct) {
    store.set(page, direct)
    return direct
  }
  const kept = referrer.startsWith(`${origin}/`) ? store.get(page) : null
  if (kept) return { ...kept, history: false }
  return fallback && { ...fallback, history: false }
}
