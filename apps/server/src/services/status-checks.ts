// The server's status checks (sources, Explore, ffmpeg, disk) and the Debug page's numbers.
import fs from 'node:fs/promises'
import { createBitmagnetBrowser, createSource } from '@magplay/indexers'
import type { SourceConfig } from '@magplay/indexers'
import type { HlsSessions, MediaTools } from '@magplay/playback'
import type { TorrentEngine } from '@magplay/torrent-engine'
import type { DebugInfo, DebugResource, StatusAction } from '@magplay/api-contract'
import { hostName } from '../config.ts'
import type { Config } from '../config.ts'
import type { LogRecord, LogLevel } from '@magplay/api-contract'
import type { CheckResult, StatusRegistry } from './status.ts'

const GB = 1024 ** 3
const formatGb = (n: number): string => `${(n / GB).toFixed(n < 10 * GB ? 2 : 1).replace(/\.?0+$/, '')} GB`
const sourcesAction: StatusAction = { label: 'Open Sources', href: '/settings#sources' }
const debugAction: StatusAction = { label: 'Open Debug', href: '/settings#debug' }
const storageAction: StatusAction = { label: 'Open Storage', href: '/settings#storage' }

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
export function createStatusChecks ({ status, config, engine, media, hls, logs, loggingStatus = () => ({ level: 'info', dropped: 0 }), version, caches = () => [] }: StatusChecksOptions): StatusChecks {
  const started = Date.now()

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

  // Without ffmpeg (the lite image) the server still streams files as they are and the browser repackages what it
  // can; nothing is re-encoded. That is a mode, not a fault, so it warns rather than fails.
  status.registerCheck({
    id: 'ffmpeg',
    label: 'ffmpeg',
    ttl: Infinity,
    required: true,
    async run () {
      const ffmpeg = media.ffmpeg() ?? await media.refreshFfmpeg()
      if (!ffmpeg.version) return { level: 'warn', value: 'Not installed', message: `ffmpeg didn’t run ("${ffmpeg.path}"). Files play directly or are repackaged in the browser; video that needs converting opens in an external player. Install ffmpeg or set FFMPEG_PATH for server-side conversion.`, action: debugAction }
      return { level: 'ok', value: ffmpeg.version }
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
      if (changed.includes('ffmpegPath')) status.invalidate('ffmpeg')
    },
    async debugInfo () {
      const sessions = hls.summary()
      const { loads, loaded } = engine.stats()
      const { probes, subtitles, probeCache } = media.stats()
      const { maxHlsSessions, hlsMaxBytes, transcodeEncoder } = config()
      return {
        version,
        node: process.versions.node,
        uptimeS: Math.round((Date.now() - started) / 1000),
        ffmpeg: media.ffmpeg()?.version ?? null,
        serverConversion: media.serverConversion(),
        encoders: media.detectedEncoders(),
        transcodeEncoder,
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
