// Indexer download links: Jackett's /dl/ and Prowlarr's /{id}/download proxies answer with a .torrent file or a redirect to a magnet.
import { HttpError } from '../errors.ts'

/**
 * @returns {Promise<string|Buffer>} a magnet URI or the .torrent file
 * @param {string} link
 * @param {{fetch?: typeof fetch}} [deps]
 */
export async function resolveLink (link, { fetch: fetchImpl = globalThis.fetch } = {}) {
  for (let hop = 0; hop < 5; hop++) {
    let res
    try {
      res = await fetchImpl(link, { redirect: 'manual', signal: AbortSignal.timeout(20_000) })
    } catch (err) {
      throw new HttpError(502, `Can't fetch the download link: ${err.cause?.code || err.message}`)
    }
    const location = res.headers.get('location')
    if (location?.startsWith('magnet:')) return location
    if (location && res.status >= 300 && res.status < 400) {
      link = new URL(location, link).href
      continue
    }
    if (!res.ok) throw new HttpError(502, `The download link returned HTTP ${res.status}`)
    const body = Buffer.from(await res.arrayBuffer())
    // Some proxies send the magnet as the body instead of a redirect
    const asText = body.subarray(0, 7).toString()
    return asText === 'magnet:' ? body.toString().trim() : body
  }
  throw new HttpError(502, 'Too many redirects from the download link')
}
