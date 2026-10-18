// The common shape every source adapter returns, so search, dedupe and the UI don't care where a result came from.
import { badges } from '@magplay/release-info'
import { SourceError, fetchFailure, isAbort } from './errors.ts'

/** fetch() as the adapters use it; tests pass a stand-in. */
export type Fetch = (url: string | URL, init?: RequestInit) => Promise<Response>

export interface Release {
  title: string
  /** 40-char lowercase hex. */
  infoHash: string | null
  magnet: string | null
  /** http(s) download link (a .torrent, or a redirect to a magnet); only when there's no magnet. */
  link: string | null
  size: number | null
  seeders: number | null
  /** Where it was found, e.g. ["Prowlarr/ExampleIndexer"]. */
  sources: string[]
  badges: string[]
  likelyDirect: boolean
  warning: string | null
}

/** Raw fields from an indexer, any of which may be missing or the wrong type. */
export interface RawRelease {
  title?: unknown
  infoHash?: unknown
  magnet?: unknown
  link?: unknown
  size?: unknown
  seeders?: unknown
}

export const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
export const asRecord = (v: unknown): Record<string, unknown> => isRecord(v) ? v : {}
export const asArray = (v: unknown): unknown[] => Array.isArray(v) ? v : []
export const asString = (v: unknown): string | undefined => typeof v === 'string' ? v : undefined
export const asNumber = (v: unknown): number | undefined => typeof v === 'number' && Number.isFinite(v) ? v : undefined

const toNum = (v: unknown): number | null =>
  v === undefined || v === null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v)

const text = (v: unknown): string => typeof v === 'string' || typeof v === 'number' ? String(v) : ''

/** Normalizes raw fields from an indexer into a Release, or null if it can't be played. */
export function release ({ title: rawTitle, infoHash: rawHash, magnet: rawMagnet, link: rawLink, size, seeders }: RawRelease, source: string): Release | null {
  const title = text(rawTitle).trim()
  if (!title) return null
  let magnet = typeof rawMagnet === 'string' && rawMagnet.startsWith('magnet:') ? rawMagnet : null
  let infoHash: string | null = (text(rawHash) || /btih:([a-f0-9]{40})/i.exec(magnet ?? '')?.[1] || '').toLowerCase()
  if (!/^[a-f0-9]{40}$/.test(infoHash)) infoHash = null
  if (!magnet && infoHash) magnet = `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(title)}`
  const link = !magnet && typeof rawLink === 'string' && /^https?:\/\//.test(rawLink) ? rawLink : null
  if (!magnet && !link) return null
  return { title, infoHash, magnet, link, size: toNum(size), seeders: toNum(seeders), sources: [source], ...badges(title) }
}

export const statusError = (status: number): SourceError =>
  new SourceError(status === 401 || status === 403 ? `HTTP ${status}: check the API key` : `HTTP ${status}`)

/** fetch() with errors turned into short, readable SourceErrors. `acceptErrors` returns non-2xx responses for the caller to read. */
export async function request (fetchImpl: Fetch, url: string | URL, opts: RequestInit, { acceptErrors = false } = {}): Promise<Response> {
  let res: Response
  try {
    res = await fetchImpl(url, opts)
  } catch (err) {
    if (isAbort(err)) throw err
    throw new SourceError(`can't reach ${new URL(url).host} (${fetchFailure(err)})`)
  }
  if (!res.ok && !acceptErrors) throw statusError(res.status)
  return res
}

/** A response body as JSON, or a SourceError naming the source when it isn't. */
export async function readJson (res: Response, what: string): Promise<unknown> {
  try {
    return await res.json()
  } catch (err) {
    if (isAbort(err)) throw err
    throw new SourceError(`${what} returned invalid JSON`)
  }
}
