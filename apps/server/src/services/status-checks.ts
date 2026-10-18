// The server's status checks (sources, Explore, ffmpeg, disk, restart) and the Debug page's numbers.
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import { createBitmagnetBrowser, createSource } from '@magplay/indexers'
import type { SourceConfig } from '@magplay/indexers'
import type { HlsSessions, MediaTools } from '@magplay/playback'
import type { TorrentEngine } from '@magplay/torrent-engine'
import { settingDef } from '@magplay/api-contract'
import type { DebugInfo, StatusAction } from '@magplay/api-contract'
import type { Config } from '../config.ts'
import type { LogTail } from '../logs.ts'
import type { SettingsStore } from '../settings-store.ts'
import type { CheckResult, StatusRegistry } from './status.ts'

const GB = 1024 ** 3
const formatGb = (n: number): string => `${(n / GB).toFixed(n < 10 * GB ? 2 : 1).replace(/\.?0+$/, '')} GB`
const sourcesAction: StatusAction = { label: 'Open Sources', href: '/settings#sources' }
const serverAction: StatusAction = { label: 'Open Server', href: '/settings#server' }

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
  logs: LogTail
  version: string
}

export interface StatusChecks {
  /** Re-runs the checks a saved setting affects, and notes the save in Recent. */
  settingsChanged: (changed: string[]) => void
  /** GET /api/debug: versions, what's busy, and the log tail. */
  debugInfo: () => Promise<DebugInfo>
}

/** Registers every check on `status`. */
export function createStatusChecks ({ status, settings, config, engine, media, hls, logs, version }: StatusChecksOptions): StatusChecks {
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
      status.registerCheck({ id: `source:${source.id ?? source.name}`, label: source.name, ttl: 60_000, required: true, run: signal => checkSource(source, signal) })
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
      if (missing.length) return { level: 'error', value: 'Missing', message: `Playback needs ffmpeg and ffprobe; "${missing.join('", "')}" didn’t run.`, action: serverAction }
      return { level: 'ok', value: ffmpeg === ffprobe ? ffmpeg ?? '' : `${ffmpeg} / ${ffprobe}` }
    },
  })

  let cacheUsage = { at: 0, bytes: 0 }
  /** Torrent cache bytes, measured at most every 30 s: it walks every file. */
  async function cachedCacheBytes (): Promise<number> {
    if (Date.now() - cacheUsage.at > 30_000) cacheUsage = { at: Date.now(), bytes: await engine.cacheBytes() }
    return cacheUsage.bytes
  }

  async function diskInfo (): Promise<DebugInfo['disk']> {
    const { cacheDir, cacheMaxBytes } = config()
    const stat = await fs.statfs(cacheDir).catch(() => null)
    if (!stat) return null
    return { free: stat.bavail * stat.bsize, size: stat.blocks * stat.bsize, cacheBytes: await cachedCacheBytes(), cacheMaxBytes }
  }

  status.registerCheck({
    id: 'disk',
    label: 'Disk',
    ttl: 30_000,
    required: true,
    async run () {
      const disk = await diskInfo()
      const { cacheDir, minFreeBytes } = config()
      if (!disk) return { level: 'error', message: `Can’t read the cache folder ${cacheDir}.`, action: serverAction }
      const value = `${formatGb(disk.free)} free`
      if (disk.free < minFreeBytes) return { level: 'error', value, message: 'Below the free-space floor: conversions stop until space is freed.', action: serverAction }
      if (disk.free < Math.max(2 * minFreeBytes, minFreeBytes + 2 * GB)) return { level: 'warn', value, message: 'Near the free-space floor; conversions will stop soon.', action: serverAction }
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
      return { level: 'warn', value: 'Pending', message: `Restart magplay to apply: ${names}.`, action: serverAction }
    },
  })

  registerSourceChecks()

  return {
    settingsChanged (changed) {
      if (changed.includes('sources')) registerSourceChecks()
      if (changed.includes('explore.bitmagnetUrl')) status.invalidate('explore')
      if (changed.some(key => key.startsWith('tools.'))) status.invalidate('ffmpeg')
      if (changed.some(key => key.startsWith('cache.') || key === 'server.cacheDir')) status.invalidate('disk')
      const describe = (key: string): string => {
        const def = settingDef(key)
        const value = settings.effective[key]
        const label = def?.label.toLowerCase() ?? key
        const unit = def && 'unit' in def && def.unit ? ` ${def.unit}` : ''
        return def && ['number', 'text', 'url', 'select', 'segmented'].includes(def.type) ? `${label} ${String(value)}${unit}` : label
      }
      status.pushEvent({ checkId: 'settings', level: 'ok', message: `Settings saved: ${changed.map(describe).join(', ')}` })
    },
    async debugInfo () {
      const sessions = hls.summary()
      const { loads, loaded } = engine.stats()
      const { probes, subtitles } = media.stats()
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
        ],
        disk: await diskInfo(),
        log: logs(),
      }
    },
  }
}
