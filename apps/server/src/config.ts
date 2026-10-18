// Runtime configuration, resolved from the settings schema: env vars, then data/settings.json, then defaults.
// All env parsing lives here, including indexer source configs, so no package reads process.env.
// `current()` is the configuration in use: live settings apply as soon as they're saved;
// restart-only settings keep their startup value until the server restarts.
import path from 'node:path'
import { SOURCE_TYPES } from '@magplay/indexers'
import type { SourceConfig, SourceType } from '@magplay/indexers'
import type { ListItem } from '@magplay/api-contract'
import { createSettingsStore, serverDefs } from './settings-store.ts'
import type { Env, EnvReaders, SettingsStore } from './settings-store.ts'

export interface Config {
  port: number
  sources: SourceConfig[]
  /** BitMagnet's origin for Explore, or null when there's none. */
  bitmagnetUrl: string | null
  searchTimeoutMs: number
  cacheDir: string
  ffmpegPath: string
  ffprobePath: string
  cacheMaxBytes: number
  maxHlsSessions: number
  maxTorrentLoads: number
  maxProbes: number
  maxSubtitleJobs: number
  hlsMaxBytes: number
  minFreeBytes: number
  torrentPort: number
  dhtEnabled: boolean
  lsdEnabled: boolean
  extraTrackers: string[]
  metadataTimeoutMs: number
  checkingTimeoutMs: number
  idleTorrentMs: number
  allowTranscode: boolean
  transcodeMaxHeight: number
}

/** The first label of an http(s) URL's host, as a default source name; anything else throws. */
export function hostName (url: string): string {
  let u: URL | undefined
  try {
    u = new URL(url)
  } catch {}
  if (!u || !/^https?:$/.test(u.protocol)) throw new Error(`Not an http(s) URL: ${url}`)
  return u.hostname.split('.')[0] ?? u.hostname
}

const splitList = (s: string): string[] => s.split(',').map(x => x.trim()).filter(Boolean)

/**
 * Source configs from env vars:
 * - TORZNAB_URL / TORZNAB_APIKEY / TORZNAB_NAME, and _2 … _9 for more Torznab feeds
 * - JACKETT_URL / JACKETT_APIKEY / JACKETT_INDEXER (default `all`)
 * - PROWLARR_URL / PROWLARR_APIKEY / PROWLARR_INDEXERS (comma-separated ids, default -2 = all torrent indexers)
 * With none set, no sources are configured (search returns nothing); the server logs a warning at startup.
 */
export function sourcesFromEnv (env: Env): SourceConfig[] {
  const out: SourceConfig[] = []
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
    out.push({ type: 'prowlarr', name: env.PROWLARR_NAME || 'Prowlarr', url: env.PROWLARR_URL, apiKey: env.PROWLARR_APIKEY || '', indexerIds: splitList(env.PROWLARR_INDEXERS || '-2') })
  }
  return out
}

/** Source items for the settings page from env vars (null when none is set), locked there. */
export function sourceItemsFromEnv (env: Env): ListItem[] | null {
  const list = sourcesFromEnv(env)
  if (!list.length) return null
  return list.map((s, i) => ({
    id: `env-${i}`,
    type: s.type,
    name: s.name,
    url: s.url,
    apiKey: s.apiKey ?? '',
    indexer: s.type === 'jackett' ? s.indexer ?? '' : s.type === 'prowlarr' ? s.indexerIds?.join(',') ?? '' : '',
  }))
}

const field = (item: ListItem, key: string): string => {
  const value = item[key]
  return typeof value === 'string' ? value : ''
}

/**
 * Source configs from the `sources` setting's items ({ id, type, name, url, apiKey, indexer }).
 * `indexer` is Jackett's indexer id or filter, or Prowlarr's comma-separated indexer ids.
 */
export function sourceConfigs (items: readonly ListItem[]): SourceConfig[] {
  return items.map(item => {
    const type = field(item, 'type')
    if (!SOURCE_TYPES.includes(type as SourceType)) throw new Error(`Unknown source type: ${type}`)
    const [name, url, indexer] = [field(item, 'name'), field(item, 'url'), field(item, 'indexer')]
    const base = { id: item.id, url, apiKey: field(item, 'apiKey') }
    if (type === 'jackett') return { ...base, type, name: name || 'Jackett', indexer: indexer || 'all' }
    if (type === 'prowlarr') return { ...base, type, name: name || 'Prowlarr', indexerIds: splitList(indexer || '-2') }
    return { ...base, type: 'torznab', name: name || hostName(url) }
  })
}

/**
 * BitMagnet's base URL for browsing: the setting (its address or its Torznab URL), otherwise a Torznab source at
 * BitMagnet's own path, /torznab/api. Null when there's no BitMagnet, which turns Explore off.
 */
export function bitmagnetUrl (explicit: string | undefined, configs: readonly SourceConfig[]): string | null {
  const candidate = explicit || configs.find(c => c.type === 'torznab' && /^\/torznab(\/api)?\/?$/.test(new URL(c.url).pathname))?.url
  return candidate ? new URL(candidate).origin : null
}

/** Settings whose env vars need more than "first non-empty variable". */
const readers: EnvReaders = {
  sources: sourceItemsFromEnv,
  // Set but empty means "no extra trackers", which differs from unset (the defaults)
  'torrents.trackers': e => e.EXTRA_TRACKERS === undefined
    ? null
    : splitList(e.EXTRA_TRACKERS).map((url, i) => ({ id: `env-${i}`, url })),
}

type Values = Readonly<Record<string, unknown>>
const num = (v: Values, key: string): number => v[key] as number
const str = (v: Values, key: string): string => v[key] as string
const bool = (v: Values, key: string): boolean => v[key] as boolean
const list = (v: Values, key: string): ListItem[] => v[key] as ListItem[]
const GB = 1024 ** 3

/** The typed configuration for settings values that already passed the schema's validate(). */
export function deriveConfig (v: Values): Config {
  const sources = sourceConfigs(list(v, 'sources'))
  return {
    port: num(v, 'server.port'),
    sources,
    bitmagnetUrl: bitmagnetUrl(str(v, 'explore.bitmagnetUrl'), sources),
    searchTimeoutMs: num(v, 'search.timeoutS') * 1000,
    cacheDir: path.resolve(str(v, 'server.cacheDir')),
    ffmpegPath: str(v, 'tools.ffmpegPath'),
    ffprobePath: str(v, 'tools.ffprobePath'),
    cacheMaxBytes: num(v, 'cache.maxGb') * GB,
    maxHlsSessions: num(v, 'limits.hlsSessions'),
    maxTorrentLoads: num(v, 'limits.torrentLoads'),
    maxProbes: num(v, 'limits.probes'),
    maxSubtitleJobs: num(v, 'limits.subtitleJobs'),
    hlsMaxBytes: num(v, 'cache.hlsMaxGb') * GB,
    minFreeBytes: num(v, 'cache.minFreeGb') * GB,
    torrentPort: num(v, 'torrents.port'),
    dhtEnabled: bool(v, 'torrents.dht'),
    lsdEnabled: bool(v, 'torrents.lsd'),
    extraTrackers: list(v, 'torrents.trackers').map(t => field(t, 'url')),
    metadataTimeoutMs: num(v, 'torrents.metadataTimeoutS') * 1000,
    checkingTimeoutMs: num(v, 'torrents.checkTimeoutS') * 1000,
    idleTorrentMs: num(v, 'torrents.idleMin') * 60_000,
    allowTranscode: bool(v, 'transcode.allow'),
    transcodeMaxHeight: num(v, 'transcode.maxHeight'),
  }
}

export interface AppConfig {
  settings: SettingsStore
  /** Where saved settings live: CACHE_DIR (or ./data) at startup, even if the cache folder setting moves the cache. */
  settingsFile: string
  /** The configuration in use now. */
  current: () => Config
  /** Runs after a save changed settings, with the new configuration and the changed keys. */
  onChange: (listener: (config: Config, changed: string[]) => void) => void
}

/** Reads env and the settings file once; an invalid env value throws, naming the variable. */
export function loadConfig (env: Env): AppConfig {
  const settingsFile = path.resolve(env.CACHE_DIR || 'data', 'settings.json')
  const settings = createSettingsStore({ file: settingsFile, env, readers })
  const restartKeys = serverDefs.filter(d => d.apply === 'restart').map(d => d.key)
  const boot = structuredClone(settings.effective)
  const inUse = (): Values => ({ ...settings.effective, ...Object.fromEntries(restartKeys.map(key => [key, boot[key]])) })
  let config = deriveConfig(inUse())
  const listeners: Array<(config: Config, changed: string[]) => void> = []
  settings.on('changed', changed => {
    config = deriveConfig(inUse())
    for (const listener of listeners) listener(config, changed)
  })
  return { settings, settingsFile, current: () => config, onChange: listener => { listeners.push(listener) } }
}
