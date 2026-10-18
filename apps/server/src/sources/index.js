// Source registry: which adapter handles each kind of indexer, and how sources are configured from env vars.
import { createTorznabSource } from './torznab.js'
import { createProwlarrSource } from './prowlarr.js'

const trimSlash = s => s.replace(/\/+$/, '')

/** Adapter factories by source type. Jackett is a Torznab preset. */
export const ADAPTERS = {
  torznab: createTorznabSource,
  prowlarr: createProwlarrSource,
  jackett: ({ url, indexer = 'all', ...rest }, deps) => createTorznabSource({
    ...rest,
    // Accept a full feed URL, or Jackett's base URL plus an indexer id, `all`, or a filter like `tag:tv,!type:private`
    url: /\/torznab(\/api)?\/?$/.test(url) ? url : `${trimSlash(url)}/api/v2.0/indexers/${encodeURIComponent(indexer)}/results/torznab/api`,
  }, deps),
}

/**
 * Source configs from env vars:
 * - TORZNAB_URL / TORZNAB_APIKEY / TORZNAB_NAME, and _2 … _9 for more Torznab feeds
 * - JACKETT_URL / JACKETT_APIKEY / JACKETT_INDEXER (default `all`)
 * - PROWLARR_URL / PROWLARR_APIKEY / PROWLARR_INDEXERS (comma-separated ids, default -2 = all torrent indexers)
 * With none set, no sources are configured (search returns nothing); the server logs a warning at startup.
 */
export function sourcesFromEnv (env) {
  const out = []
  for (const n of ['', '_2', '_3', '_4', '_5', '_6', '_7', '_8', '_9']) {
    const url = env[`TORZNAB_URL${n}`]
    if (!url) continue
    out.push({ type: 'torznab', name: env[`TORZNAB_NAME${n}`] || hostName(url), url, apiKey: env[`TORZNAB_APIKEY${n}`] || '' })
  }
  if (env.JACKETT_URL) {
    hostName(env.JACKETT_URL)
    out.push({ type: 'jackett', name: env.JACKETT_NAME || 'Jackett', url: env.JACKETT_URL, apiKey: env.JACKETT_APIKEY || '', indexer: env.JACKETT_INDEXER || 'all' })
  }
  if (env.PROWLARR_URL) {
    hostName(env.PROWLARR_URL)
    const indexerIds = (env.PROWLARR_INDEXERS || '-2').split(',').map(s => s.trim()).filter(Boolean)
    out.push({ type: 'prowlarr', name: env.PROWLARR_NAME || 'Prowlarr', url: env.PROWLARR_URL, apiKey: env.PROWLARR_APIKEY || '', indexerIds })
  }
  return out
}

export function hostName (url) {
  let u
  try {
    u = new URL(url)
  } catch {}
  if (!/^https?:$/.test(u?.protocol)) throw new Error(`Not an http(s) URL: ${url}`)
  return u.hostname.split('.')[0]
}

/**
 * Source configs from the `sources` setting's items ({ id, type, name, url, apiKey, indexer }).
 * `indexer` is Jackett's indexer id or filter, or Prowlarr's comma-separated indexer ids.
 */
export function sourceConfigs (items) {
  return items.map(({ id, type, name, url, apiKey, indexer }) => {
    const base = { id, type, url, apiKey }
    if (type === 'jackett') return { ...base, name: name || 'Jackett', indexer: indexer || 'all' }
    if (type === 'prowlarr') return { ...base, name: name || 'Prowlarr', indexerIds: (indexer || '-2').split(',').map(s => s.trim()).filter(Boolean) }
    return { ...base, name: name || hostName(url) }
  })
}

/** Source items for the settings page from env vars (null when none is set), locked there. */
export function sourceItemsFromEnv (env) {
  const list = sourcesFromEnv(env)
  return list.length ? list.map((s, i) => ({ id: `env-${i}`, type: s.type, name: s.name, url: s.url, apiKey: s.apiKey, indexer: s.indexer ?? s.indexerIds?.join(',') ?? '' })) : null
}

/** Builds adapters from configs; `deps` (e.g. a mock fetch) is passed to every adapter. */
export function createSources (configs, deps) {
  return configs.map(({ type, id, ...opts }) => {
    if (!ADAPTERS[type]) throw new Error(`Unknown source type: ${type}`)
    return ADAPTERS[type](opts, deps)
  })
}

/**
 * BitMagnet's base URL for browsing: BITMAGNET_URL (its address or its Torznab URL), otherwise a Torznab source at
 * BitMagnet's own path, /torznab/api. Null when there's no BitMagnet, which turns Explore off.
 */
export function bitmagnetUrl (env, configs) {
  const candidate = env.BITMAGNET_URL || configs.find(c => c.type === 'torznab' && /^\/torznab(\/api)?\/?$/.test(new URL(c.url).pathname))?.url
  return candidate ? new URL(candidate).origin : null
}
