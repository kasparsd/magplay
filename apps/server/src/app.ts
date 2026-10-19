// The magplay server as one object: createApp() builds the packages and services from a config,
// listen() binds the port and close() releases everything. Nothing happens at import time.
import http from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { execFile } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { createLogging, createMetrics } from '@magplay/observability'
import type { Logger, Logging } from '@magplay/observability'
import type { DebugResource } from '@magplay/api-contract'
import { createRouter, route } from '@magplay/http-kit'
import { createHlsSessions, createMediaTools } from '@magplay/playback'
import type { HlsSessions, SpawnProcess } from '@magplay/playback'
import { createTorrentEngine } from '@magplay/torrent-engine'
import type { AppConfig, Config } from './config.ts'
import { HttpError, toHttpError } from './http/errors.ts'
import { json } from './http/request.ts'
import { apiRoutes } from './http/routes.ts'
import { staticRoutes } from './http/static.ts'
import { createExplore } from './services/explore.ts'
import { createPlay } from './services/play.ts'
import { createSearchService } from './services/search.ts'
import { createStatusChecks } from './services/status-checks.ts'
import { createStatus } from './services/status.ts'
import { createSubtitles } from './services/subtitles.ts'
import { createTabs } from './services/tabs.ts'
import { version } from './version.ts'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

export interface AppOptions {
  config: AppConfig
  logging?: Logging
  publicDir?: string
  distDir?: string
  /** Replaces ffmpeg for HLS sessions, for tests. */
  spawnProcess?: SpawnProcess
}

export interface App {
  server: Server
  metrics: () => Promise<string>
  listenMetrics: (port?: number, host?: string) => Promise<number>
  /** The HLS sessions, for diagnostics and tests. */
  hls: HlsSessions
  /** Binds the HTTP port (the config's when omitted) and resolves with the bound port. */
  listen: (port?: number) => Promise<number>
  /** Startup checks: a warning when there are no sources, and whether ffmpeg and ffprobe run. Explore's counts start loading. */
  startupChecks: () => void
  /** Stops accepting requests, ends open ones (streams included), stops every ffmpeg and closes the torrent engine. */
  close: () => Promise<void>
}

/** Fails if the HLS folder can't be created; the torrent engine is created after it, so nothing is left bound. */
export function createApp ({ config, logging: suppliedLogging, publicDir = path.join(repoRoot, 'public'), distDir = path.join(repoRoot, 'dist/client'), spawnProcess }: AppOptions): App {
  const current = config.current
  const boot = current()
  let port = boot.port
  const logging = suppliedLogging ?? createLogging({ level: boot.logLevel, version })
  const log = logging.logger
  const telemetry = createMetrics({ version, runtime: false })
  const metrics = telemetry.metrics
  let configurationRevision = 0

  let detectedEncoders: string[] = []
  const tabs = createTabs(() => hls)
  const hls = createHlsSessions({
    dir: path.join(boot.cacheDir, 'hls'),
    logger: log.child({ component: 'hls' }),
    metrics,
    live: () => {
      const c = current()
      return { ffmpegPath: c.ffmpegPath, maxSessions: c.maxHlsSessions, hlsMaxBytes: c.hlsMaxBytes, minFreeBytes: c.minFreeBytes, transcodeMaxHeight: c.transcodeMaxHeight, transcodeEncoder: c.transcodeEncoder, vaapiDevice: c.vaapiDevice, detectedEncoders }
    },
    onStop: tabs.forget,
    ...(spawnProcess && { spawnProcess }),
  })
  const media = createMediaTools({
    logger: log.child({ component: 'media' }),
    metrics,
    live: () => {
      const c = current()
      return { ffprobePath: c.ffprobePath, ffmpegPath: c.ffmpegPath, maxProbes: c.maxProbes, maxSubtitleJobs: c.maxSubtitleJobs }
    },
  })
  media.refreshEncoders().then(e => { detectedEncoders = e }).catch(() => {})
  const engine = createTorrentEngine({
    dir: path.join(boot.cacheDir, 'torrents'),
    logger: log.child({ component: 'torrent' }),
    metrics,
    port: boot.torrentPort,
    dht: boot.dhtEnabled,
    lsd: boot.lsdEnabled,
    live: () => {
      const c = current()
      return {
        maxLoads: c.maxTorrentLoads,
        extraTrackers: c.extraTrackers,
        metadataTimeoutMs: c.metadataTimeoutMs,
        checkingTimeoutMs: c.checkingTimeoutMs,
        idleMs: c.idleTorrentMs,
        cacheMaxBytes: c.cacheMaxBytes,
      }
    },
  })

  /** ffmpeg and ffprobe read torrent files through /raw on the loopback address. */
  const input = (ih: string, idx: number): string => `http://127.0.0.1:${port}/raw/${ih}/${idx}`
  const play = createPlay({ engine, media, tabs, input, logger: log.child({ component: 'playback' }), metrics, policy: () => ({ allowTranscode: current().allowTranscode, transcodeMaxHeight: current().transcodeMaxHeight }) })
  const subtitles = createSubtitles({ engine, media, input })
  const search = createSearchService({ sources: () => current().sources, timeoutMs: () => current().searchTimeoutMs, engine, logger: log.child({ component: 'search' }), metrics })
  const explore = createExplore({ url: () => current().bitmagnetUrl, timeoutMs: () => current().searchTimeoutMs, showAdult: () => current().showAdult, logger: log.child({ component: 'explore' }), metrics })
  const status = createStatus({ logger: log.child({ component: 'status' }) })
  const caches = (): DebugResource[] => {
    const subs = subtitles.stats()
    return [
      { id: 'subtitleCache', label: 'Subtitle tracks cached', used: subs.tracks, limit: subs.limit },
      { id: 'subtitleBytes', label: 'Subtitle cache size', used: subs.bytes, limit: subs.byteLimit, unit: 'bytes' },
      { id: 'links', label: 'Download links remembered', ...search.linkStats() },
      { id: 'exploreCache', label: 'Explore answers cached', ...explore.cacheStats() },
    ]
  }
  const checks = createStatusChecks({ status, config: current, engine, media, hls, logs: logging.tail, loggingStatus: logging.status, version, caches })

  // Saved settings apply without a restart: rebuild what was built from them
  const unsubscribe = config.onChange((_config, changed) => {
    configurationRevision++
    log.info('settings.changed', { changed, configurationRevision })
    if (changed.includes('ffmpegPath') || changed.includes('transcode.encoder')) media.refreshEncoders().then(e => { detectedEncoders = e }).catch(() => {})
    if (changed.includes('sources') || changed.includes('search.timeoutS')) search.rebuild()
    if (changed.includes('sources') || changed.includes('explore.bitmagnetUrl')) explore.rebuild()
    checks.settingsChanged(changed)
  })

  const requestLogs = new WeakMap<IncomingMessage, Logger>()
  const startedAt = Date.now()
  let closing: Promise<void> | null = null
  const match = createRouter([
    // Liveness and readiness for Docker and proxies: cheap, no upstream calls; 503 once shutdown has begun
    route('GET', '/health', ({ res }) => {
      json(res, closing ? 503 : 200, { ok: !closing, uptimeS: Math.round((Date.now() - startedAt) / 1000) })
    }),
    ...staticRoutes({ publicDir, distDir }),
    ...apiRoutes({ engine, hls, tabs, play, search, explore, subtitles, settings: config.settings, status, checks, logger: log, requestLogger: req => requestLogs.get(req) ?? log }),
  ])

  async function handle (req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader('Cache-Control', 'no-store') // Safe default for live APIs, mutations, redirects and errors.
    const requestId = randomUUID()
    res.setHeader('X-Request-Id', requestId)
    const requestLog = log.child({ component: 'http', requestId, configurationRevision })
    requestLogs.set(req, requestLog)
    const started = performance.now()
    let pattern = 'unmatched'
    let terminal = false
    const finish = (): void => {
      if (terminal) return
      terminal = true
      const aborted = !res.writableFinished
      const status = aborted ? 499 : res.statusCode
      const durationMs = performance.now() - started
      metrics.http(pattern, req.method ?? 'GET', status, durationMs / 1000)
      requestLog[status >= 500 ? 'warn' : 'debug'](aborted ? 'http.request.aborted' : 'http.request.completed', { route: pattern, method: req.method, status, aborted, durationMs })
    }
    res.once('finish', finish)
    res.once('close', finish)
    let url: URL | undefined
    try {
      try { url = new URL(req.url ?? '', 'http://localhost') } catch { pattern = 'malformed'; throw new HttpError(400, 'Malformed URL') }
      const found = match(req.method ?? 'GET', url.pathname) ?? (req.method === 'HEAD' ? match('GET', url.pathname) : null)
      if (!found) throw new HttpError(404, 'Not found')
      pattern = found.pattern
      await found.handler({ requestId, req, res, params: found.params, query: url.searchParams })
    } catch (err) {
      const failure = toHttpError(err)
      if (failure.unexpected) requestLog.error('http.failed', { err, route: pattern })
      if (res.destroyed) return
      if (res.headersSent) {
        res.destroy()
        return
      }
      if (failure.retryAfter) res.setHeader('Retry-After', String(failure.retryAfter))
      json(res, failure.status, { error: failure.message })
    }
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err: unknown) => { log.error('http.responding.failed', { err }); res.destroy() })
  })
  server.requestTimeout = 0 // /raw streams stay open for as long as playback needs

  const management = http.createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    if (req.method !== 'GET' || req.url !== '/metrics') { res.writeHead(404); res.end(); return }
    telemetry.registry.metrics().then(body => {
      if (res.destroyed) return
      res.setHeader('Content-Type', telemetry.registry.contentType)
      res.end(body)
    }, () => { res.writeHead(500); res.end() })
  })
  telemetry.startRuntime()
  const snapshot = (): void => {
    const h = hls.summary()
    const e = engine.stats()
    const m = media.stats()
    telemetry.slots('hls', h.active, current().maxHlsSessions)
    telemetry.slots('torrent', e.loads.used, e.loads.limit)
    telemetry.slots('probe', m.probes.used, m.probes.limit)
    telemetry.slots('subtitle', m.subtitles.used, m.subtitles.limit)
    telemetry.storage('hls', h.bytes)
    telemetry.cache('probe', m.probeCache.used)
    telemetry.cache('subtitle', subtitles.stats().tracks)
    telemetry.cache('links', search.linkStats().used)
    telemetry.cache('explore', explore.cacheStats().used)
    telemetry.drops(logging.status().dropped)
    const disk = checks.diskSnapshot()
    if (disk) {
      telemetry.storage('free', disk.free)
      telemetry.storage('torrent', disk.cacheBytes)
      telemetry.observed(disk.at)
    }
  }
  snapshot()
  const sampler = setInterval(snapshot, 1000)
  sampler.unref()
  // Shares the existing bounded disk measurement, never a scan on scrape.
  const sampleDisk = (): void => { checks.refreshDisk().catch(() => {}) }
  sampleDisk()
  const diskSampler = setInterval(sampleDisk, 30_000)
  diskSampler.unref()

  return {
    server,
    metrics: async () => { snapshot(); return await telemetry.registry.metrics() },
    listenMetrics (wanted = boot.metricsPort, host = boot.metricsHost) {
      return new Promise((resolve, reject) => {
        management.once('error', reject)
        management.listen(wanted, host, () => {
          management.off('error', reject)
          const address = management.address()
          const port = typeof address === 'object' && address ? address.port : wanted
          log.info('metrics.listening', { port })
          resolve(port)
        })
      })
    },
    hls,
    listen (wanted = boot.port) {
      return new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(wanted, () => {
          server.off('error', reject)
          const address = server.address()
          port = typeof address === 'object' && address ? address.port : wanted
          log.info('server.listening', { port, count: current().sources.length }, 'magplay listening')
          resolve(port)
        })
      })
    },
    startupChecks () {
      startupWarnings(current(), log)
      explore.warm()
    },
    close () {
      closing ??= (async () => {
        unsubscribe()
        clearInterval(sampler)
        clearInterval(diskSampler)
        const stoppedMetrics = new Promise<void>(resolve => management.close(() => resolve()))
        management.closeAllConnections()
        const stopped = new Promise<void>(resolve => server.close(() => resolve()))
        // Media streams and status polls would hold close() open; nothing is mid-write that matters
        server.closeAllConnections()
        await Promise.all([stopped, stoppedMetrics, hls.close(), engine.close(), checks.close()])
        telemetry.close()
        await logging.flush()
      })()
      return closing
    },
  }
}

/** Fail loudly at startup, not mid-playback: check the external binaries, and note missing indexers. */
function startupWarnings (c: Config, logger: Logger): void {
  if (!c.sources.length) {
    logger.warn('server.sources.missing', {}, 'No sources configured. Add one in Settings → Sources.')
  }
  for (const [bin, varName] of [[c.ffprobePath, 'FFPROBE_PATH'], [c.ffmpegPath, 'FFMPEG_PATH']] as const) {
    execFile(bin, ['-version'], err => {
      logger[err ? 'warn' : 'info']('server.tool.checked', { tool: varName, outcome: err ? 'failure' : 'success' })
    })
  }
}
