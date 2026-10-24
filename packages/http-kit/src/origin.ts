// A guard for writes: there is no login, so stop other sites' pages from changing the server through the browser.
// API clients that aren't browsers (curl, scripts, other apps) send neither header and are let through.
import type { IncomingMessage } from 'node:http'

/**
 * True for a request a browser made from a page on another site: `Sec-Fetch-Site` other than `same-origin` or `none`
 * (typed or bookmarked), or, from browsers that don't send it, an `Origin` that doesn't match the Host. A request
 * with neither header didn't come from a web page and is not cross-site.
 */
export function isCrossSite (req: IncomingMessage): boolean {
  const site = req.headers['sec-fetch-site']
  if (site) return site !== 'same-origin' && site !== 'none'
  const origin = req.headers.origin
  if (!origin) return false
  const host = req.headers['x-forwarded-host'] ?? req.headers.host
  try {
    return new URL(origin).host !== host
  } catch {
    return true
  }
}
