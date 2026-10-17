import path from 'node:path'
import { bitmagnetUrl, sourcesFromEnv } from './sources/index.js'

const env = process.env
const num = (key, def) => {
  const n = Number(env[key])
  return env[key] && Number.isFinite(n) ? n : def
}

function resourceNum (key, fallback, integer = false) {
  const value = env[key] === undefined || env[key] === '' ? fallback : Number(env[key])
  if (!Number.isFinite(value) || value <= 0 || (integer && !Number.isSafeInteger(value))) {
    throw new Error(`${key} must be a positive ${integer ? 'integer' : 'number'}`)
  }
  return value
}

const DEFAULT_TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://explodie.org:6969/announce',
  'udp://exodus.desync.com:6969/announce',
].join(',')

export default {
  port: num('PORT', 8080),
  sources: sourcesFromEnv(env),
  get bitmagnetUrl () { return bitmagnetUrl(env, this.sources) },
  searchTimeoutMs: num('SEARCH_TIMEOUT_S', 30) * 1000,
  cacheDir: path.resolve(env.CACHE_DIR || 'data'),
  ffmpegPath: env.FFMPEG_PATH || 'ffmpeg',
  ffprobePath: env.FFPROBE_PATH || 'ffprobe',
  cacheMaxBytes: num('CACHE_MAX_GB', 50) * 1024 ** 3,
  maxHlsSessions: resourceNum('MAX_HLS_SESSIONS', 2, true),
  maxTorrentLoads: resourceNum('MAX_TORRENT_LOADS', 4, true),
  maxProbes: resourceNum('MAX_PROBES', 2, true),
  maxSubtitleJobs: resourceNum('MAX_SUBTITLE_JOBS', 1, true),
  hlsMaxBytes: resourceNum('HLS_MAX_GB', 8) * 1024 ** 3,
  minFreeBytes: resourceNum('MIN_FREE_GB', 0.25) * 1024 ** 3,
  torrentPort: num('TORRENT_PORT', 6881),
  dhtEnabled: !/^(0|false|no|off)$/i.test(env.DHT_ENABLED || ''),
  lsdEnabled: !/^(0|false|no|off)$/i.test(env.LSD_ENABLED || ''),
  extraTrackers: (env.EXTRA_TRACKERS ?? DEFAULT_TRACKERS).split(',').map(s => s.trim()).filter(Boolean),
  metadataTimeoutMs: num('METADATA_TIMEOUT_S', 60) * 1000,
  checkingTimeoutMs: resourceNum('TORRENT_CHECK_TIMEOUT_S', 7200) * 1000,
  idleTorrentMs: num('IDLE_TORRENT_MIN', 30) * 60_000,
  allowTranscode: /^(1|true|yes|on)$/i.test(env.ALLOW_VIDEO_TRANSCODE || ''),
  transcodeMaxHeight: num('TRANSCODE_MAX_HEIGHT', 720),
}
