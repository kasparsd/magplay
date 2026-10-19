// The server's status checks (sources, Explore, ffmpeg, disk) and the Debug page's numbers.
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import { createBitmagnetBrowser, createSource } from '@magplay/indexers'
import type { SourceConfig } from '@magplay/indexers'
import type { HlsSessions, MediaTools } from '@magplay/playback'
import type { TorrentEngine } from '@magplay/torrent-engine'
import type { DebugInfo, DebugResource, StatusAction } from '@magplay/api-contract'
import { hostName } from '../config.ts'
import type { Config } from '../config.ts'
import type { LogRecord, LogLevel } from '@magplay/api-contract'
import type { SettingsStore } from '../settings-store.ts'
import type { CheckResult, StatusRegistry } from './status.ts'

const GB = 1024 ** 3
const formatGb = (n: number): string => `${(n / GB).toFixed(n < 10 * GB ? 2 : 1).replace(/\.?0+$/, '')} GB`
const sourcesAction: StatusAction = { label: 'Open Sources', href: '/settings#sources' }
const debugAction: StatusAction = { label: 'Open Debug', href: '/settings#debug' }
const storageAction: StatusAction = { label: 'Open Storage', href: '/settings#storage' }

/** The version an ffmpeg-family binary reports, or null when it can't run. */
export function binaryVersion (bin: string): Promise<string | null> {
  return new Promise(resolve => {
    execFile(bin, ['-version'], { timeout: 10_000 }, (err, stdout) => {
      resolve(err ? null : (/version (n?[\d.]+|\S+)/.exec(stdout)?.[1] ?? 'unknown').replace(/^n/, ''))
    })
  })
}

/** One source's health with the given config (saved, or unsaved values from the Test button). */
export async function checkSource (config: SourceConfig, signal: AbortSignal = AbortSignal.timeout(10_000)): Promise<CheckResult> {
  const started = Date.now()
  try {
    await createSource(config).check({ signal })
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
    const message = timedOut ? 'Didn’t answer in time.' : err instanceof Error ? err.message : String(err)
    return { level: 'error', value: timedOut ? 'No answer' : 'Failed', message, action: sourcesAction }
  }
  return { level: 'ok', value: `${Date.now() - started} ms` }
}

export interface StatusChecksOptions {
  status: StatusRegistry
  settings: SettingsStore
  config: () => Config
  engine: TorrentEngine
  media: MediaTools
  hls: HlsSessions
  logs: () => LogRecord[]
  loggingStatus?: () => { level: LogLevel | 'silent', dropped: number }
  version: string
  /** In-memory caches (count used and limit), listed under Debug after the busy slots. */
  caches?: () => DebugResource[]
}

export interface StatusChecks {
  /** Re-runs the checks a saved setting affects. */
  settingsChanged: (changed: string[]) => void
  /** GET /api/debug: versions, what's busy, and the log tail. */
  debugInfo: () => Promise<DebugInfo>
  close: () => Promise<void>
  refreshDisk: () => Promise<void>
  diskSnapshot: () => (NonNullable<DebugInfo['disk']> & { at: number }) | null
}

/** Registers every check on `status`. */
export function createStatusChecks ({ status, settings, config, engine, media, hls, logs, loggingStatus = () => ({ level: 'info', dropped: 0 }), version, caches = () => [] }: StatusChecksOptions): StatusChecks {
  const started = Date.now()
  const versions: { ffmpeg: string | null, ffprobe: string | null } = { ffmpeg: null, ffprobe: null }

  function registerSourceChecks (): void {
    status.removeChecks(id => id === 'sources' || id.startsWith('source:'))
    const { sources } = config()
    if (!sources.length) {
      status.registerCheck({
        id: 'sources',
        label: 'Sources',
        ttl: Infinity,
        required: true,
        run: () => ({ level: 'error', message: 'No sources are set up, so search finds nothing.', action: { label: 'Add a source', href: '/settings#sources' } }),
      })
    }
    for (const source of sources) {
      status.registerCheck({ id: `source:${source.id ?? hostName(source.url)}`, label: hostName(source.url), ttl: 60_000, required: true, run: signal => checkSource(source, signal) })
    }
  }

  status.registerCheck({
    id: 'explore',
    label: 'Explore',
    ttl: 60_000,
    async run (signal) {
      const { bitmagnetUrl } = config()
      if (!bitmagnetUrl) return { level: 'warn', message: 'Explore needs BitMagnet’s address.', action: { label: 'Set it', href: '/settings#sources' } }
      await createBitmagnetBrowser({ url: bitmagnetUrl }).check({ signal })
      return { level: 'ok', value: 'BitMagnet GraphQL' }
    },
  })

  status.registerCheck({
    id: 'ffmpeg',
    label: 'ffmpeg',
    ttl: Infinity,
    required: true,
    async run () {
      const { ffmpegPath, ffprobePath } = config()
      const [ffmpeg, ffprobe] = await Promise.all([binaryVersion(ffmpegPath), binaryVersion(ffprobePath)])
      Object.assign(versions, { ffmpeg, ffprobe })
      const missing = [!ffmpeg && ffmpegPath, !ffprobe && ffprobePath].filter(Boolean)
      if (missing.length) return { level: 'error', value: 'Missing', message: `Playback needs ffmpeg and ffprobe; "${missing.join('", "')}" didn’t run. Install them, or set FFMPEG_PATH and FFPROBE_PATH.`, action: debugAction }
      return { level: 'ok', value: ffmpeg === ffprobe ? ffmpeg ?? '' : `${ffmpeg} / ${ffprobe}` }
    },
  })

  let cacheUsage = { at: 0, bytes: 0 }
  let latestDisk: (NonNullable<DebugInfo['disk']> & { at: number }) | null = null
  let measuring: Promise<DebugInfo['disk']> | null = null
  /** Torrent cache bytes, measured at most every 30 s: it walks every file. */
  async function cachedCacheBytes (): Promise<number> {
    if (Date.now() - cacheUsage.at > 30_000) cacheUsage = { at: Date.now(), bytes: await engine.cacheBytes() }
    return cacheUsage.bytes
  }

  async function measureDisk (): Promise<DebugInfo['disk']> {
    const { cacheDir, cacheMaxBytes } = config()
    const stat = await fs.statfs(cacheDir).catch(() => null)
    if (!stat) return null
    latestDisk = { free: stat.bavail * stat.bsize, size: stat.blocks * stat.bsize, cacheBytes: await cachedCacheBytes(), cacheMaxBytes, at: Date.now() }
    return latestDisk
  }

  function diskInfo (): Promise<DebugInfo['disk']> {
    measuring ??= measureDisk().finally(() => { measuring = null })
    return measuring
  }

  status.registerCheck({
    id: 'disk',
    label: 'Disk',
    ttl: 30_000,
    required: true,
    async run () {
      const disk = await diskInfo()
      const { cacheDir, minFreeBytes } = config()
      if (!disk) return { level: 'error', message: `Can’t read the cache folder ${cacheDir}.`, action: storageAction }
      const value = `${formatGb(disk.free)} free`
      if (disk.free < minFreeBytes) return { level: 'error', value, message: 'Below the free-space floor: conversions stop until space is freed.', action: storageAction }
      if (disk.free < Math.max(2 * minFreeBytes, minFreeBytes + 2 * GB)) return { level: 'warn', value, message: 'Near the free-space floor; conversions will stop soon.', action: storageAction }
      return { level: 'ok', value }
    },
  })

  registerSourceChecks()

  return {
    close: async () => { await measuring?.catch(() => {}) },
    refreshDisk: async () => { await diskInfo() },
    diskSnapshot: () => latestDisk,
    settingsChanged (changed) {
      if (changed.includes('sources')) registerSourceChecks()
      if (changed.includes('explore.bitmagnetUrl')) status.invalidate('explore')
      if (changed.some(key => key.startsWith('cache.'))) status.invalidate('disk')
    },
    async debugInfo () {
      const sessions = hls.summary()
      const { loads, loaded } = engine.stats()
      const { probes, subtitles, probeCache } = media.stats()
      const { maxHlsSessions, hlsMaxBytes } = config()
      return {
        version,
        node: process.versions.node,
        uptimeS: Math.round((Date.now() - started) / 1000),
        ffmpeg: versions.ffmpeg,
        ffprobe: versions.ffprobe,
        resources: [
          { id: 'conversions', label: 'Conversions', used: sessions.active, limit: maxHlsSessions },
          { id: 'torrentLoads', label: 'Torrents loading', ...loads },
          { id: 'torrents', label: 'Torrents loaded', used: loaded, limit: 0 },
          { id: 'probes', label: 'Probes', ...probes },
          { id: 'subtitles', label: 'Subtitle jobs', ...subtitles },
          { id: 'hls', label: 'Conversion storage', used: sessions.bytes, limit: hlsMaxBytes, unit: 'bytes' },
          { id: 'probeCache', label: 'Probe results cached', ...probeCache },
          ...caches(),
        ],
        disk: await diskInfo(),
        log: logs(),
        logging: loggingStatus(),
      }
    },
  }
}
