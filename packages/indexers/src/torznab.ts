// Torznab adapter: BitMagnet, Jackett (per indexer, `all`, or filter feeds), Prowlarr per-indexer feeds, NZBHydra2.
import { XMLParser } from 'fast-xml-parser'
import { SourceError } from './errors.ts'
import { asArray, asRecord, asString, isRecord, readText, release, request, statusError } from './release.ts'
import type { Fetch, Release } from './release.ts'
import type { CheckOptions, SearchOptions, Source } from './source.ts'

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  parseTagValue: false, // keep titles like "1917" as strings
  parseAttributeValue: false,
  isArray: name => name === 'item' || name === 'torznab:attr',
})

const parseXml = (xml: string): Record<string, unknown> => asRecord(parser.parse(xml))

/** Text of a node that may be a string or {#text, ...attrs}. */
const text = (node: unknown): string => {
  const value = isRecord(node) ? node['#text'] : node
  return typeof value === 'string' || typeof value === 'number' ? String(value) : ''
}

/** Torznab reports bad keys etc. as <error code description>. */
function throwIfError (doc: Record<string, unknown>): void {
  if (!doc.error) return
  const error = asRecord(doc.error)
  throw new SourceError(`indexer error: ${text(error.description) || text(error.code)}`)
}

export interface TorznabOptions {
  name: string
  url: string
  apiKey?: string
}

export function createTorznabSource ({ name, url, apiKey }: TorznabOptions, { fetch: fetchImpl = globalThis.fetch }: { fetch?: Fetch } = {}): Source {
  return {
    name,
    async search (q: string, { cat, signal }: SearchOptions) {
      const u = new URL(url)
      u.searchParams.set('t', 'search') // never tvsearch+season/ep: it hides season packs
      u.searchParams.set('q', q)
      u.searchParams.set('limit', '100')
      if (cat) u.searchParams.set('cat', cat)
      if (apiKey) u.searchParams.set('apikey', apiKey)
      // Torznab servers report bad keys etc. as <error code description> with a 4xx status
      const res = await request(fetchImpl, u, { signal }, { acceptErrors: true })
      const body = await readText(res, name)
      if (!res.ok && !body.includes('<error')) throw statusError(res.status)
      return parseTorznabFeed(body, name)
    },
    /** A cheap request for the status menu: the feed's capabilities. Throws a SourceError when it fails. */
    async check ({ signal }: CheckOptions = {}) {
      const u = new URL(url)
      u.searchParams.set('t', 'caps')
      if (apiKey) u.searchParams.set('apikey', apiKey)
      const res = await request(fetchImpl, u, signal ? { signal } : {}, { acceptErrors: true })
      if (res.status === 401 || res.status === 403) throw statusError(res.status)
      parseTorznabCaps(await readText(res, name), res.ok ? null : res.status)
    },
  }
}

/** Checks a t=caps answer: a Torznab <error> or a non-feed body throws. `status` is a failed HTTP status, if any. */
export function parseTorznabCaps (xml: string, status: number | null = null): void {
  const doc = parseXml(xml)
  throwIfError(doc)
  if (status !== null) throw statusError(status)
  if (!doc.caps) throw new SourceError('not a Torznab feed')
}

/** Torznab RSS to Releases. Every attribute is optional; BitMagnet often has no seeders and uses the infohash as guid. */
export function parseTorznabFeed (xml: string, source: string): Release[] {
  const doc = parseXml(xml)
  throwIfError(doc)
  if (!doc.rss) throw new SourceError('not a Torznab feed')
  const items = asArray(asRecord(asRecord(doc.rss).channel).item)
  return items.map(raw => {
    const item = asRecord(raw)
    const attrs: Record<string, unknown> = {}
    for (const a of asArray(item['torznab:attr'])) {
      const attr = asRecord(a)
      const attrName = asString(attr.name)
      if (attrName) attrs[attrName.toLowerCase()] = attr.value
    }
    const enclosure = asRecord(item.enclosure)
    const guid = text(item.guid)
    const enclosureUrl = text(enclosure.url)
    // Jackett: magneturl attr is the raw magnet; <link>/<enclosure> is its /dl/ proxy; <guid> is the tracker page
    const links = [text(attrs.magneturl), enclosureUrl, text(item.link), guid].filter(Boolean)
    return release({
      title: text(item.title),
      infoHash: text(attrs.infohash) || /^[a-f0-9]{40}$/i.exec(guid)?.[0],
      magnet: links.find(l => l.startsWith('magnet:')),
      link: [enclosureUrl, text(item.link)].find(l => /^https?:/.test(l)),
      size: attrs.size ?? item.size ?? enclosure.length,
      seeders: attrs.seeders,
      // Aggregate feeds (Jackett `all`, Prowlarr) name the tracker each item came from
    }, [source, text(item.jackettindexer ?? item.prowlarrindexer)].filter(Boolean).join('/'))
  }).filter(r => r !== null)
}
