// Runtime configuration, resolved from the settings schema: env vars, then data/settings.json, then defaults.
// Callers read `config.x` when they need it, so live settings apply as soon as they're saved;
// restart-only settings keep their startup value here until the server restarts.
import path from 'node:path'
import { bitmagnetUrl, sourceConfigs, sourceItemsFromEnv } from './sources/index.js'
import { createSettingsStore, serverDefs } from './settings-store.ts'

const env = process.env

/** Settings whose env vars need more than "first non-empty variable". */
const readers = {
  sources: sourceItemsFromEnv,
  // Set but empty means "no extra trackers", which differs from unset (the defaults)
  'torrents.trackers': e => e.EXTRA_TRACKERS === undefined
    ? null
    : e.EXTRA_TRACKERS.split(',').map(s => s.trim()).filter(Boolean).map((url, i) => ({ id: `env-${i}`, url })),
}

// The settings file lives where CACHE_DIR (or ./data) points at startup, even if the cache folder setting moves the cache
export const settingsFile = path.resolve(env.CACHE_DIR || 'data', 'settings.json')
export const settings = createSettingsStore({ file: settingsFile, env, readers })

const restartKeys = serverDefs.filter(d => d.apply === 'restart').map(d => d.key)
const boot = structuredClone(settings.effective)

function derive (v) {
  const sources = sourceConfigs(v.sources)
  return {
    port: v['server.port'],
    sources,
    bitmagnetUrl: bitmagnetUrl({ BITMAGNET_URL: v['explore.bitmagnetUrl'] }, sources),
    searchTimeoutMs: v['search.timeoutS'] * 1000,
    cacheDir: path.resolve(v['server.cacheDir']),
    ffmpegPath: v['tools.ffmpegPath'],
    ffprobePath: v['tools.ffprobePath'],
    cacheMaxBytes: v['cache.maxGb'] * 1024 ** 3,
    maxHlsSessions: v['limits.hlsSessions'],
    maxTorrentLoads: v['limits.torrentLoads'],
    maxProbes: v['limits.probes'],
    maxSubtitleJobs: v['limits.subtitleJobs'],
    hlsMaxBytes: v['cache.hlsMaxGb'] * 1024 ** 3,
    minFreeBytes: v['cache.minFreeGb'] * 1024 ** 3,
    torrentPort: v['torrents.port'],
    dhtEnabled: v['torrents.dht'],
    lsdEnabled: v['torrents.lsd'],
    extraTrackers: v['torrents.trackers'].map(t => t.url),
    metadataTimeoutMs: v['torrents.metadataTimeoutS'] * 1000,
    checkingTimeoutMs: v['torrents.checkTimeoutS'] * 1000,
    idleTorrentMs: v['torrents.idleMin'] * 60_000,
    allowTranscode: v['transcode.allow'],
    transcodeMaxHeight: v['transcode.maxHeight'],
  }
}

const inUse = () => ({ ...settings.effective, ...Object.fromEntries(restartKeys.map(key => [key, boot[key]])) })
const config = derive(inUse())
settings.on('changed', () => Object.assign(config, derive(inUse())))

export default config
