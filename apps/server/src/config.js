// Runtime configuration. Settings the page edits resolve from env vars, then data/settings.json, then defaults;
// callers read `config.x` when they need it, so a saved setting applies on its next use.
// Knobs the page doesn't show (ports, limits, timeouts, trackers, programs) come from env vars only,
// validated the same way.
import path from 'node:path'
import { bitmagnetUrl, sourceConfigs, sourceItemsFromEnv } from './sources/index.js'
import { createSettingsStore, resolve } from './settings-store.ts'

const env = process.env

const DEFAULT_TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://explodie.org:6969/announce',
  'udp://exodus.desync.com:6969/announce',
]

const count = (key, envName, fallback, max) => ({ key, env: [envName], type: 'number', default: fallback, min: 1, max, integer: true })
const seconds = (key, envName, fallback) => ({ key, env: [envName], type: 'number', default: fallback, min: 1 })
/** Env-only knobs, in the settings schema's shape so they validate (and fail at startup) like the rest. */
const ENV_ONLY = [
  { key: 'port', env: ['PORT'], type: 'number', default: 8080, min: 1, max: 65535, integer: true },
  { key: 'torrentPort', env: ['TORRENT_PORT'], type: 'number', default: 6881, min: 0, max: 65535, integer: true },
  { key: 'cacheDir', env: ['CACHE_DIR'], type: 'text', default: 'data' },
  { key: 'ffmpegPath', env: ['FFMPEG_PATH'], type: 'text', default: 'ffmpeg' },
  { key: 'ffprobePath', env: ['FFPROBE_PATH'], type: 'text', default: 'ffprobe' },
  { key: 'dhtEnabled', env: ['DHT_ENABLED'], type: 'toggle', default: true },
  { key: 'lsdEnabled', env: ['LSD_ENABLED'], type: 'toggle', default: true },
  count('maxHlsSessions', 'MAX_HLS_SESSIONS', 2, 16),
  count('maxTorrentLoads', 'MAX_TORRENT_LOADS', 4, 64),
  count('maxProbes', 'MAX_PROBES', 2, 16),
  count('maxSubtitleJobs', 'MAX_SUBTITLE_JOBS', 1, 16),
  seconds('metadataTimeoutS', 'METADATA_TIMEOUT_S', 60),
  seconds('checkTimeoutS', 'TORRENT_CHECK_TIMEOUT_S', 7200),
  { key: 'idleTorrentMin', env: ['IDLE_TORRENT_MIN'], type: 'number', default: 30, min: 1 },
]
const fixed = resolve(env, {}, {}, ENV_ONLY).effective
// Set but empty means "no extra trackers", which differs from unset (the defaults)
const extraTrackers = env.EXTRA_TRACKERS === undefined ? DEFAULT_TRACKERS : env.EXTRA_TRACKERS.split(',').map(s => s.trim()).filter(Boolean)

// The settings file lives where CACHE_DIR (or ./data) points
export const settingsFile = path.resolve(fixed.cacheDir, 'settings.json')
export const settings = createSettingsStore({ file: settingsFile, env, readers: { sources: sourceItemsFromEnv } })

function derive (v) {
  const sources = sourceConfigs(v.sources)
  return {
    sources,
    bitmagnetUrl: bitmagnetUrl({ BITMAGNET_URL: v['explore.bitmagnetUrl'] }, sources),
    searchTimeoutMs: v['search.timeoutS'] * 1000,
    cacheMaxBytes: v['cache.maxGb'] * 1024 ** 3,
    hlsMaxBytes: v['cache.hlsMaxGb'] * 1024 ** 3,
    minFreeBytes: v['cache.minFreeGb'] * 1024 ** 3,
    allowTranscode: v['transcode.allow'],
    transcodeMaxHeight: v['transcode.maxHeight'],
  }
}

const config = {
  port: fixed.port,
  torrentPort: fixed.torrentPort,
  cacheDir: path.resolve(fixed.cacheDir),
  ffmpegPath: fixed.ffmpegPath,
  ffprobePath: fixed.ffprobePath,
  dhtEnabled: fixed.dhtEnabled,
  lsdEnabled: fixed.lsdEnabled,
  maxHlsSessions: fixed.maxHlsSessions,
  maxTorrentLoads: fixed.maxTorrentLoads,
  maxProbes: fixed.maxProbes,
  maxSubtitleJobs: fixed.maxSubtitleJobs,
  extraTrackers,
  metadataTimeoutMs: fixed.metadataTimeoutS * 1000,
  checkingTimeoutMs: fixed.checkTimeoutS * 1000,
  idleTorrentMs: fixed.idleTorrentMin * 60_000,
  ...derive(settings.effective),
}
settings.on('changed', () => Object.assign(config, derive(settings.effective)))

export default config
