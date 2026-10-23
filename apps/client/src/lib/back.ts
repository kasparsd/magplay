// Where a page's "←" link goes: back to the page the user came from, named for what it shows.

export interface BackTarget {
  label: string
  href: string
  /** The Router return target is the previous history entry: go Back, which keeps its scroll position and results. */
  history: boolean
}

/**
 * The back link for a page reached from a Router history return URL. Only pages of this app count, and only ones
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
