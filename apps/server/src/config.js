import { EventEmitter } from 'node:events'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { serverSettings, settingByKey, validateSetting } from '@magplay/api-contract'
import { bitmagnetUrl, sourcesFromEnv } from './sources/index.js'

const env = process.env
const DEFAULT_TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://explodie.org:6969/announce',
  'udp://exodus.desync.com:6969/announce',
].join(',')
const maxHlsSessions = resourceNum('MAX_HLS_SESSIONS', 2, true)
const minFreeBytes = resourceNum('MIN_FREE_GB', 0.25) * 1024 ** 3
const dataDir = path.resolve(env.CACHE_DIR || 'data')
const settingsPath = path.join(dataDir, 'settings.json')
const events = new EventEmitter()
let saved = {}
let minFreeBytesOverride

const num = (key, def) => {
  const n = Number(env[key])
  return env[key] && Number.isFinite(n) ? n : def
}
function resourceNum (key, fallback, integer = false) {
  const value = env[key] === undefined || env[key] === '' ? fallback : Number(env[key])
  if (!Number.isFinite(value) || value <= 0 || (integer && !Number.isSafeInteger(value))) throw new Error(`${key} must be a positive ${integer ? 'integer' : 'number'}`)
  return value
}
const enabled = key => !/^(0|false|no|off)$/i.test(env[key] || '')
const transcodeEnabled = /^(1|true|yes|on)$/i.test(env.ALLOW_VIDEO_TRANSCODE || '')

function envValue (def) {
  const keys = Array.isArray(def.env) ? def.env : [def.env]
  const key = keys.find(key => key && env[key] !== undefined && env[key] !== '')
  if (!key) return undefined
  const raw = env[key]
  if (def.type === 'toggle') return key === 'ALLOW_VIDEO_TRANSCODE' ? transcodeEnabled : enabled(key)
  if (def.type === 'number' || (def.type === 'select' && typeof def.default === 'number')) return Number(raw)
  return raw
}

function valueFor (def) {
  if (def.key === 'sources') return [...sourcesFromEnv(env), ...(Array.isArray(saved.sources) ? saved.sources : [])]
  const fromEnv = envValue(def)
  if (fromEnv !== undefined) return fromEnv
  if (saved[def.key] !== undefined) return saved[def.key]
  if (def.key === 'extraTrackers') return DEFAULT_TRACKERS
  return def.default
}

function metaFor (def) {
  if (def.key === 'sources') {
    const sources = sourcesFromEnv(env)
    return { source: sources.length ? 'env' : saved.sources ? 'file' : 'default', env: sources.length ? 'TORZNAB_URL, JACKETT_URL or PROWLARR_URL' : undefined, envSources: sources.length }
  }
  const keys = Array.isArray(def.env) ? def.env : [def.env]
  const key = keys.find(key => key && env[key] !== undefined && env[key] !== '')
  return key ? { source: 'env', env: key } : saved[def.key] !== undefined ? { source: 'file' } : { source: 'default' }
}

export function settingsSnapshot () {
  const values = {}
  const meta = {}
  for (const def of serverSettings) {
    values[def.key] = valueFor(def)
    meta[def.key] = metaFor(def)
  }
  return { values, meta }
}

export async function loadSettings () {
  try {
    const parsed = JSON.parse(await readFile(settingsPath, 'utf8'))
    saved = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch (err) {
    if (err?.code !== 'ENOENT') console.warn(`[settings] Could not read ${settingsPath}: ${err.message}`)
    saved = {}
  }
}

/** Atomically apply a complete, already-parsed patch. Environment values remain locked. */
export async function updateSettings (patch) {
  const errors = []
  const writable = {}
  for (const [key, value] of Object.entries(patch)) {
    const def = settingByKey.get(key)
    if (!def || def.scope !== 'server') { errors.push({ key, message: 'Unknown setting.' }); continue }
    if (metaFor(def).source === 'env' && def.key !== 'sources') { errors.push({ key, message: `Set by ${metaFor(def).env}; change it outside magplay.` }); continue }
    const error = validateSetting(def, value)
    if (error) { errors.push({ key, message: error }); continue }
    writable[key] = value
  }
  if (errors.length) return { errors }
  if (Array.isArray(writable.sources)) {
    const previous = Array.isArray(saved.sources) ? saved.sources : []
    writable.sources = writable.sources.map((source, index) => ({
      ...source,
      apiKey: source.apiKey || previous[index]?.apiKey || '',
      apiKeySet: undefined,
    }))
  }
  saved = { ...saved, ...writable }
  await mkdir(path.dirname(settingsPath), { recursive: true })
  const temporary = `${settingsPath}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temporary, JSON.stringify(saved, null, 2) + '\n', { mode: 0o600 })
  await rename(temporary, settingsPath)
  const changed = Object.keys(writable)
  if (changed.length) events.emit('changed', changed)
  return { values: settingsSnapshot().values, changed }
}

export const onSettingsChanged = listener => { events.on('changed', listener); return () => events.off('changed', listener) }

const config = {
  get port () { return valueFor(settingByKey.get('port')) },
  get sources () { return valueFor(settingByKey.get('sources')) },
  get bitmagnetUrl () { return valueFor(settingByKey.get('bitmagnetUrl')) || bitmagnetUrl({}, this.sources) },
  get searchTimeoutMs () { return valueFor(settingByKey.get('searchTimeoutS')) * 1000 },
  get cacheDir () { return path.resolve(valueFor(settingByKey.get('cacheDir'))) },
  ffmpegPath: env.FFMPEG_PATH || 'ffmpeg',
  ffprobePath: env.FFPROBE_PATH || 'ffprobe',
  get cacheMaxBytes () { return valueFor(settingByKey.get('cacheMaxGb')) * 1024 ** 3 },
  get maxHlsSessions () { return env.MAX_HLS_SESSIONS === undefined || env.MAX_HLS_SESSIONS === '' ? valueFor(settingByKey.get('maxHlsSessions')) : maxHlsSessions },
  maxTorrentLoads: resourceNum('MAX_TORRENT_LOADS', 4, true),
  maxProbes: resourceNum('MAX_PROBES', 2, true),
  maxSubtitleJobs: resourceNum('MAX_SUBTITLE_JOBS', 1, true),
  hlsMaxBytes: resourceNum('HLS_MAX_GB', 8) * 1024 ** 3,
  get minFreeBytes () { return minFreeBytesOverride ?? (env.MIN_FREE_GB === undefined || env.MIN_FREE_GB === '' ? valueFor(settingByKey.get('minFreeGb')) * 1024 ** 3 : minFreeBytes) },
  set minFreeBytes (value) { minFreeBytesOverride = value },
  get torrentPort () { return valueFor(settingByKey.get('torrentPort')) },
  get dhtEnabled () { return valueFor(settingByKey.get('dhtEnabled')) },
  get lsdEnabled () { return valueFor(settingByKey.get('lsdEnabled')) },
  get extraTrackers () { return String(valueFor(settingByKey.get('extraTrackers'))).split(',').map(s => s.trim()).filter(Boolean) },
  metadataTimeoutMs: num('METADATA_TIMEOUT_S', 60) * 1000,
  checkingTimeoutMs: resourceNum('TORRENT_CHECK_TIMEOUT_S', 7200) * 1000,
  get idleTorrentMs () { return valueFor(settingByKey.get('idleTorrentMin')) * 60_000 },
  get allowTranscode () { return valueFor(settingByKey.get('allowTranscode')) },
  get transcodeMaxHeight () { return valueFor(settingByKey.get('transcodeMaxHeight')) },
}

await loadSettings()
export default config
