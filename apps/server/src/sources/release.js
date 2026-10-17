// The common shape every source adapter returns, so search, dedupe and the UI don't care where a result came from.
import { badges } from '@magplay/release-info'

const toNum = v => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v))

/**
 * @typedef {object} Release
 * @property {string} title
 * @property {string|null} infoHash  40-char lowercase hex
 * @property {string|null} magnet
 * @property {string|null} link      http(s) download link (a .torrent, or a redirect to a magnet); only when there's no magnet
 * @property {number|null} size
 * @property {number|null} seeders
 * @property {string[]} sources      where it was found, e.g. ["Prowlarr/ExampleIndexer"]
 * @property {string[]} badges
 * @property {boolean} likelyDirect
 */

/** Normalizes raw fields from an indexer into a Release, or null if it can't be played. */
export function release ({ title, infoHash, magnet, link, size, seeders }, source) {
  title = String(title ?? '').trim()
  if (!title) return null
  magnet = typeof magnet === 'string' && magnet.startsWith('magnet:') ? magnet : null
  infoHash = String(infoHash || magnet?.match(/btih:([a-f0-9]{40})/i)?.[1] || '').toLowerCase()
  if (!/^[a-f0-9]{40}$/.test(infoHash)) infoHash = null
  if (!magnet && infoHash) magnet = `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(title)}`
  link = !magnet && typeof link === 'string' && /^https?:\/\//.test(link) ? link : null
  if (!magnet && !link) return null
  return { title, infoHash, magnet, link, size: toNum(size), seeders: toNum(seeders), sources: [source], ...badges(title) }
}

/** Error for a source that answered but failed; `message` is shown to the user next to the source name. */
export class SourceError extends Error {}

export const statusError = status =>
  new SourceError(status === 401 || status === 403 ? `HTTP ${status}: check the API key` : `HTTP ${status}`)

/** fetch() with errors turned into short, readable SourceErrors. `acceptErrors` returns non-2xx responses for the caller to read. */
export async function request (fetchImpl, url, opts, { acceptErrors = false } = {}) {
  let res
  try {
    res = await fetchImpl(url, opts)
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') throw err
    throw new SourceError(`can't reach ${new URL(url).host} (${err.cause?.code || err.message})`)
  }
  if (!res.ok && !acceptErrors) throw statusError(res.status)
  return res
}
