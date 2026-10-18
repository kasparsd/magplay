import parseTorrent from 'parse-torrent'
import { InvalidTorrentError } from './errors.ts'

/** Validate without contacting peers. Keep trackers and other hints for the eventual add. */
export async function readMagnet (input: string): Promise<{ magnet: string, infoHash: string, name: string | null }> {
  try {
    const url = new URL(input)
    const xt = url.searchParams.getAll('xt').find(value => /^urn:btih:(?:[a-f0-9]{40}|[a-z2-7]{32})$/i.test(value))
    if (url.protocol !== 'magnet:' || !xt) throw new Error('Missing BitTorrent v1 info hash')
    // parse-torrent expects xt unescaped; normalize it while retaining every other hint.
    const magnet = `magnet:?${[...url.searchParams].map(([key, value]) => `${encodeURIComponent(key)}=${key === 'xt' ? (/^urn:btih:/i.test(value) ? xt.toLowerCase() : value) : encodeURIComponent(value)}`).join('&')}`
    const parsed = await parseTorrent(`magnet:?xt=${xt.toLowerCase()}`)
    if (!/^[a-f0-9]{40}$/.test(parsed.infoHash)) throw new Error('Invalid info hash')
    return { magnet, infoHash: parsed.infoHash, name: url.searchParams.get('dn')?.trim() || null }
  } catch {
    throw new InvalidTorrentError('Enter a valid magnet link with a BitTorrent v1 info hash (urn:btih).')
  }
}
