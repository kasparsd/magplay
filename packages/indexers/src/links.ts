// Indexer download links: Jackett's /dl/ and Prowlarr's /{id}/download proxies answer with a .torrent file or a redirect to a magnet.
import { SourceError, fetchFailure } from './errors.ts'
import type { Fetch } from './release.ts'

/** A magnet URI, or the .torrent file's bytes. */
export async function resolveLink (link: string, { fetch: fetchImpl = globalThis.fetch }: { fetch?: Fetch } = {}): Promise<string | Buffer> {
  for (let hop = 0; hop < 5; hop++) {
    let res: Response
    try {
      res = await fetchImpl(link, { redirect: 'manual', signal: AbortSignal.timeout(20_000) })
    } catch (err) {
      throw new SourceError(`Can't fetch the download link: ${fetchFailure(err)}`)
    }
    const location = res.headers.get('location')
    if (location?.startsWith('magnet:')) return location
    if (location && res.status >= 300 && res.status < 400) {
      link = new URL(location, link).href
      continue
    }
    if (!res.ok) throw new SourceError(`The download link returned HTTP ${res.status}`)
    const body = Buffer.from(await res.arrayBuffer())
    // Some proxies send the magnet as the body instead of a redirect
    const asText = body.subarray(0, 7).toString()
    return asText === 'magnet:' ? body.toString().trim() : body
  }
  throw new SourceError('Too many redirects from the download link')
}
