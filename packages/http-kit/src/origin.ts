// A guard for writes: there is no login, so stop other sites' pages from changing settings through the browser.
import type { IncomingMessage } from 'node:http'

/**
 * True for requests a page on this same origin made: `Sec-Fetch-Site: same-origin`, or, from browsers
 * that don't send it, an Origin header matching the Host. Anything else (another site, or no browser
 * headers at all) is refused.
 */
export function isSameOrigin (req: IncomingMessage): boolean {
  const site = req.headers['sec-fetch-site']
  if (site) return site === 'same-origin'
  const origin = req.headers.origin
  const host = req.headers['x-forwarded-host'] ?? req.headers.host
  if (!origin || !host) return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}
