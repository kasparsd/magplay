// Torznab adapter: BitMagnet, Jackett (per indexer, `all`, or filter feeds), Prowlarr per-indexer feeds, NZBHydra2.
import { XMLParser } from 'fast-xml-parser'
import { release, request, SourceError, statusError } from './release.js'

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  parseTagValue: false, // keep titles like "1917" as strings
  parseAttributeValue: false,
  isArray: name => name === 'item' || name === 'torznab:attr',
})

/** Text of a node that may be a string or {#text, ...attrs}. */
const text = node => String((node && typeof node === 'object' ? node['#text'] : node) ?? '')

/**
 * @param {{name: string, url: string, apiKey?: string}} opts
 * @param {{fetch?: typeof fetch}} [deps]
 */
export function createTorznabSource ({ name, url, apiKey }, { fetch: fetchImpl = globalThis.fetch } = {}) {
  return {
    name,
    async search (q, { cat, signal } = {}) {
      const u = new URL(url)
      u.searchParams.set('t', 'search') // never tvsearch+season/ep: it hides season packs
      u.searchParams.set('q', q)
      u.searchParams.set('limit', '100')
      if (cat) u.searchParams.set('cat', cat)
      if (apiKey) u.searchParams.set('apikey', apiKey)
      // Torznab servers report bad keys etc. as <error code description> with a 4xx status
      const res = await request(fetchImpl, u, { signal }, { acceptErrors: true })
      const body = await res.text()
      if (!res.ok && !body.includes('<error')) throw statusError(res.status)
      return parseFeed(body, name)
    },
  }
}

/** Torznab RSS to Releases. Every attribute is optional; BitMagnet often has no seeders and uses the infohash as guid. */
export function parseFeed (xml, source) {
  const doc = parser.parse(xml)
  if (doc.error) throw new SourceError(`indexer error: ${doc.error.description || doc.error.code}`)
  if (!doc.rss) throw new SourceError('not a Torznab feed')
  return (doc.rss.channel?.item ?? []).map(item => {
    const attrs = {}
    for (const a of item['torznab:attr'] ?? []) if (a?.name) attrs[a.name.toLowerCase()] = a.value
    const guid = text(item.guid)
    // Jackett: magneturl attr is the raw magnet; <link>/<enclosure> is its /dl/ proxy; <guid> is the tracker page
    const links = [attrs.magneturl, item.enclosure?.url, text(item.link), guid].filter(Boolean).map(String)
    return release({
      title: text(item.title),
      infoHash: attrs.infohash || guid.match(/^[a-f0-9]{40}$/i)?.[0],
      magnet: links.find(l => l.startsWith('magnet:')),
      link: [item.enclosure?.url, text(item.link)].map(String).find(l => /^https?:/.test(l)),
      size: attrs.size ?? item.size ?? item.enclosure?.length,
      seeders: attrs.seeders,
      // Aggregate feeds (Jackett `all`, Prowlarr) name the tracker each item came from
    }, [source, text(item.jackettindexer ?? item.prowlarrindexer)].filter(Boolean).join('/'))
  }).filter(Boolean)
}
