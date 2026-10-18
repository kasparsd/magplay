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

/** The most an indexer answer may be: a 100-result feed is well under 1 MiB, so this only stops runaway bodies. */
export const MAX_BODY_BYTES = 16 * 1024 ** 2
const MAX_REDIRECTS = 3

/** Whether a redirect from `from` to `to` keeps the request's credentials on the same server (an http → https upgrade is fine). */
const sameServer = (from: URL, to: URL): boolean =>
  from.hostname === to.hostname && (from.protocol === to.protocol ? from.port === to.port : from.protocol === 'http:' && to.protocol === 'https:')

/**
 * fetch() with errors turned into short, readable SourceErrors. `acceptErrors` returns non-2xx responses for the caller to read.
 * Redirects are followed only on the same server (at most three), so an API key in a header or query string never reaches another host.
 */
export async function request (fetchImpl: Fetch, url: string | URL, opts: RequestInit, { acceptErrors = false } = {}): Promise<Response> {
  let target = new URL(url)
  for (let hop = 0; ; hop++) {
    let res: Response
    try {
      res = await fetchImpl(target, { ...opts, redirect: 'manual' })
    } catch (err) {
      if (isAbort(err)) throw err
      throw new SourceError(`can't reach ${target.host} (${fetchFailure(err)})`)
    }
    const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null
    if (location) {
      const next = new URL(location, target)
      if (!sameServer(target, next)) throw new SourceError(`redirected to another server (${next.host}); use that address instead`)
      if (hop >= MAX_REDIRECTS) throw new SourceError('too many redirects')
      await res.body?.cancel()
      target = next
      continue
    }
    if (!res.ok && !acceptErrors) {
      await res.body?.cancel()
      throw statusError(res.status)
    }
    return res
  }
}

/** A response body as bytes, cut off with a SourceError past `limit` instead of reading a runaway answer into memory. */
export async function readBytes (res: Response, what: string, limit = MAX_BODY_BYTES): Promise<Buffer> {
  const declared = Number(res.headers.get('content-length'))
  if (declared > limit) {
    await res.body?.cancel()
    throw new SourceError(`${what} sent ${Math.round(declared / 1024 ** 2)} MB, more than the ${limit / 1024 ** 2} MB limit`)
  }
  if (!res.body) return Buffer.alloc(0)
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      size += chunk.byteLength
      if (size > limit) throw new SourceError(`${what} sent more than the ${limit / 1024 ** 2} MB limit`)
      chunks.push(chunk)
    }
  } catch (err) {
    await res.body.cancel().catch(() => {})
    throw err
  }
  return Buffer.concat(chunks)
}

/** A response body as text, bounded like readBytes(). */
export async function readText (res: Response, what: string, limit = MAX_BODY_BYTES): Promise<string> {
  return (await readBytes(res, what, limit)).toString('utf8')
}

/** A response body as JSON, bounded like readBytes(), or a SourceError naming the source when it isn't JSON. */
export async function readJson (res: Response, what: string, limit = MAX_BODY_BYTES): Promise<unknown> {
  const text = await readText(res, what, limit)
  try {
    return JSON.parse(text)
  } catch {
    throw new SourceError(`${what} returned invalid JSON`)
  }
}
