// The server's status checks (sources, Explore, ffmpeg, disk, restart) and the Debug page's numbers.
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { settingDef } from '@magplay/api-contract'
import config, { settings } from './config.js'
import { createStatus } from './status.ts'
import { createSources } from './sources/index.js'
import { createBitmagnetBrowser } from './sources/bitmagnet.js'
import { runProbeJob, runSubtitleJob } from './media.js'
import { cacheBytes, loadedTorrents, runTorrentLoad } from './torrents.js'
import { sessionSummary } from './sessions.js'

export const status = createStatus()

const GB = 1024 ** 3
const formatGb = n => `${(n / GB).toFixed(n < 10 * GB ? 2 : 1).replace(/\.?0+$/, '')} GB`
const sourcesAction = { label: 'Open Sources', href: '/settings#sources' }

/** The version an ffmpeg-family binary reports, or null when it can't run. */
export function binaryVersion (bin) {
  return new Promise(resolve => {
    execFile(bin, ['-version'], { timeout: 10_000 }, (err, stdout) => {
      resolve(err ? null : (/version (n?[\d.]+|\S+)/.exec(stdout)?.[1] ?? 'unknown').replace(/^n/, ''))
    })
  })
}

/** One source's health with the given config (saved, or unsaved values from the Test button). */
export async function checkSource (cfg, signal = AbortSignal.timeout(10_000)) {
  const [adapter] = createSources([cfg])
  const started = Date.now()
  try {
    await adapter.check({ signal })
  } catch (err) {
    const timedOut = err.name === 'TimeoutError' || err.name === 'AbortError'
    const message = timedOut ? `${cfg.name} didn’t answer in time` : `${cfg.name}: ${err.message}`
    return { level: 'error', value: timedOut ? 'No answer' : 'Failed', message, action: sourcesAction }
  }
  return { level: 'ok', value: `${Date.now() - started} ms` }
}

function registerSourceChecks () {
  status.removeChecks(id => id === 'sources' || id.startsWith('source:'))
  if (!config.sources.length) {
    status.registerCheck({
      id: 'sources',
      label: 'Sources',
      ttl: Infinity,
      required: true,
      run: () => ({ level: 'error', message: 'No sources are set up, so search finds nothing.', action: { label: 'Add a source', href: '/settings#sources' } }),
    })
  }
  for (const cfg of config.sources) {
    status.registerCheck({ id: `source:${cfg.id}`, label: cfg.name, ttl: 60_000, required: true, run: signal => checkSource(cfg, signal) })
  }
}

status.registerCheck({
  id: 'explore',
  label: 'Explore',
  ttl: 60_000,
  async run (signal) {
    if (!config.bitmagnetUrl) return { level: 'warn', message: 'Explore needs BitMagnet’s address.', action: { label: 'Set it', href: '/settings#sources' } }
    await createBitmagnetBrowser({ url: config.bitmagnetUrl }).check({ signal })
    return { level: 'ok', value: 'BitMagnet GraphQL' }
  },
})

export const versions = { ffmpeg: null, ffprobe: null }
status.registerCheck({
  id: 'ffmpeg',
  label: 'ffmpeg',
  ttl: Infinity,
  required: true,
  async run () {
    const [ffmpeg, ffprobe] = await Promise.all([binaryVersion(config.ffmpegPath), binaryVersion(config.ffprobePath)])
    Object.assign(versions, { ffmpeg, ffprobe })
    const missing = [!ffmpeg && config.ffmpegPath, !ffprobe && config.ffprobePath].filter(Boolean)
    if (missing.length) return { level: 'error', value: 'Missing', message: `Playback needs ffmpeg and ffprobe; "${missing.join('", "')}" didn’t run.`, action: { label: 'Open Server', href: '/settings#server' } }
    return { level: 'ok', value: ffmpeg === ffprobe ? ffmpeg : `${ffmpeg} / ${ffprobe}` }
  },
})

let cacheUsage = { at: 0, bytes: 0 }
/** Torrent cache bytes, measured at most every 30 s: it walks every file. */
async function cachedCacheBytes () {
  if (Date.now() - cacheUsage.at > 30_000) cacheUsage = { at: Date.now(), bytes: await cacheBytes() }
  return cacheUsage.bytes
}

export async function diskInfo () {
  const stat = await fs.statfs(config.cacheDir).catch(() => null)
  if (!stat) return null
  return { free: stat.bavail * stat.bsize, size: stat.blocks * stat.bsize, cacheBytes: await cachedCacheBytes(), cacheMaxBytes: config.cacheMaxBytes }
}

status.registerCheck({
  id: 'disk',
  label: 'Disk',
  ttl: 30_000,
  required: true,
  async run () {
    const disk = await diskInfo()
    const action = { label: 'Open Server', href: '/settings#server' }
    if (!disk) return { level: 'error', message: `Can’t read the cache folder ${config.cacheDir}.`, action }
    const value = `${formatGb(disk.free)} free`
    if (disk.free < config.minFreeBytes) return { level: 'error', value, message: 'Below the free-space floor: conversions stop until space is freed.', action }
    if (disk.free < Math.max(2 * config.minFreeBytes, config.minFreeBytes + 2 * GB)) return { level: 'warn', value, message: 'Near the free-space floor; conversions will stop soon.', action }
    return { level: 'ok', value }
  },
})

status.registerCheck({
  id: 'restart',
  label: 'Restart needed',
  ttl: 0,
  run () {
    const keys = settings.pendingRestart()
    if (!keys.length) return null
    const names = keys.map(key => settingDef(key)?.label.toLowerCase() ?? key).join(', ')
    return { level: 'warn', value: 'Pending', message: `Restart magplay to apply: ${names}.`, action: { label: 'Open Server', href: '/settings#server' } }
  },
})

registerSourceChecks()

/** Re-runs the checks a saved setting affects, and notes the save in Recent. */
settings.on('changed', changed => {
  if (changed.includes('sources')) registerSourceChecks()
  if (changed.includes('explore.bitmagnetUrl')) status.invalidate('explore')
  if (changed.some(key => key.startsWith('tools.'))) status.invalidate('ffmpeg')
  if (changed.some(key => key.startsWith('cache.') || key === 'server.cacheDir')) status.invalidate('disk')
  const describe = key => {
    const def = settingDef(key)
    const value = settings.effective[key]
    const label = def?.label.toLowerCase() ?? key
    return def && ['number', 'text', 'url', 'select', 'segmented'].includes(def.type) ? `${label} ${value}${def.unit ? ` ${def.unit}` : ''}` : label
  }
  status.pushEvent({ checkId: 'settings', level: 'ok', message: `Settings saved: ${changed.map(describe).join(', ')}` })
})

const started = Date.now()
const { version } = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'))

/** GET /api/debug: versions, what's busy, and the log tail. */
export async function debugInfo (log) {
  const sessions = sessionSummary()
  return {
    version,
    node: process.versions.node,
    uptimeS: Math.round((Date.now() - started) / 1000),
    ffmpeg: versions.ffmpeg,
    ffprobe: versions.ffprobe,
    resources: [
      { id: 'conversions', label: 'Conversions', used: sessions.active, limit: config.maxHlsSessions },
      { id: 'torrentLoads', label: 'Torrents loading', ...runTorrentLoad.stats() },
      { id: 'torrents', label: 'Torrents loaded', used: loadedTorrents(), limit: 0 },
      { id: 'probes', label: 'Probes', ...runProbeJob.stats() },
      { id: 'subtitles', label: 'Subtitle jobs', ...runSubtitleJob.stats() },
      { id: 'hls', label: 'Conversion storage', used: sessions.bytes, limit: config.hlsMaxBytes, unit: 'bytes' },
    ],
    disk: await diskInfo(),
    log,
  }
}
