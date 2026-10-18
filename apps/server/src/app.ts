// The magplay server as one object: createApp() builds the packages and services from a config,
// listen() binds the port and close() releases everything. Nothing happens at import time.
import http from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { redactSecrets } from '@magplay/api-contract'
import type { DebugResource } from '@magplay/api-contract'
import { createRouter, route } from '@magplay/http-kit'
import { createHlsSessions, createMediaTools } from '@magplay/playback'
import type { HlsSessions, SpawnProcess } from '@magplay/playback'
import { createTorrentEngine } from '@magplay/torrent-engine'
import type { AppConfig, Config } from './config.ts'
import type { LogTail } from './logs.ts'
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

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

export interface AppOptions {
  config: AppConfig
  logs?: LogTail
  publicDir?: string
  distDir?: string
  /** Replaces ffmpeg for HLS sessions, for tests. */
  spawnProcess?: SpawnProcess
}

export interface App {
  server: Server
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
export function createApp ({ config, logs = () => [], publicDir = path.join(repoRoot, 'public'), distDir = path.join(repoRoot, 'dist/client'), spawnProcess }: AppOptions): App {
  const current = config.current
  const boot = current()
  let port = boot.port

  const tabs = createTabs(() => hls)
  const hls = createHlsSessions({
    dir: path.join(boot.cacheDir, 'hls'),
    live: () => {
      const c = current()
      return { ffmpegPath: c.ffmpegPath, maxSessions: c.maxHlsSessions, hlsMaxBytes: c.hlsMaxBytes, minFreeBytes: c.minFreeBytes, transcodeMaxHeight: c.transcodeMaxHeight }
    },
    onStop: tabs.forget,
    ...(spawnProcess && { spawnProcess }),
  })
  const media = createMediaTools({
    live: () => {
      const c = current()
      return { ffprobePath: c.ffprobePath, ffmpegPath: c.ffmpegPath, maxProbes: c.maxProbes, maxSubtitleJobs: c.maxSubtitleJobs }
    },
  })
  const engine = createTorrentEngine({
    dir: path.join(boot.cacheDir, 'torrents'),
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
  const play = createPlay({ engine, media, tabs, input, policy: () => ({ allowTranscode: current().allowTranscode, transcodeMaxHeight: current().transcodeMaxHeight }) })
  const subtitles = createSubtitles({ engine, media, input })
  const search = createSearchService({ sources: () => current().sources, timeoutMs: () => current().searchTimeoutMs, engine })
  const explore = createExplore({ url: () => current().bitmagnetUrl, timeoutMs: () => current().searchTimeoutMs })
  const status = createStatus()
  const { version } = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as { version: string }
  const caches = (): DebugResource[] => {
    const subs = subtitles.stats()
    return [
      { id: 'subtitleCache', label: 'Subtitle tracks cached', used: subs.tracks, limit: subs.limit },
      { id: 'subtitleBytes', label: 'Subtitle cache size', used: subs.bytes, limit: subs.byteLimit, unit: 'bytes' },
      { id: 'links', label: 'Download links remembered', ...search.linkStats() },
      { id: 'exploreCache', label: 'Explore answers cached', ...explore.cacheStats() },
    ]
  }
  const checks = createStatusChecks({ status, settings: config.settings, config: current, engine, media, hls, logs, version, caches })

  // Saved settings apply without a restart: rebuild what was built from them
  const unsubscribe = config.onChange((_config, changed) => {
    if (changed.includes('sources') || changed.includes('search.timeoutS')) search.rebuild()
    if (changed.includes('sources') || changed.includes('explore.bitmagnetUrl')) explore.rebuild()
    checks.settingsChanged(changed)
  })

  const startedAt = Date.now()
  let closing: Promise<void> | null = null
  const match = createRouter([
    // Liveness and readiness for Docker and proxies: cheap, no upstream calls; 503 once shutdown has begun
    route('GET', '/health', ({ res }) => {
      json(res, closing ? 503 : 200, { ok: !closing, uptimeS: Math.round((Date.now() - startedAt) / 1000) })
    }),
    ...staticRoutes({ publicDir, distDir }),
    ...apiRoutes({ engine, hls, tabs, play, search, explore, subtitles, settings: config.settings, status, checks }),
  ])

  async function handle (req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader('Cache-Control', 'no-store') // Safe default for live APIs, mutations, redirects and errors.
    let url: URL | undefined
    try {
      try { url = new URL(req.url ?? '', 'http://localhost') } catch { throw new HttpError(400, 'Malformed URL') }
      const found = match(req.method ?? 'GET', url.pathname) ?? (req.method === 'HEAD' ? match('GET', url.pathname) : null)
      if (!found) throw new HttpError(404, 'Not found')
      await found.handler({ req, res, params: found.params, query: url.searchParams })
    } catch (err) {
      const failure = toHttpError(err)
      if (failure.unexpected) console.error(`[http] ${req.method} ${url?.pathname ?? req.url}:`, err)
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
    handle(req, res).catch((err: unknown) => console.error('[http] responding:', err))
  })
  server.requestTimeout = 0 // /raw streams stay open for as long as playback needs

  return {
    server,
    hls,
    listen (wanted = boot.port) {
      return new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(wanted, () => {
          server.off('error', reject)
          const address = server.address()
          port = typeof address === 'object' && address ? address.port : wanted
          const { sources } = current()
          console.log(`magplay listening on :${port}, sources: ${sources.map(c => `${c.name} (${c.type} ${redactSecrets(c.url)})`).join(', ') || 'none'}`)
          resolve(port)
        })
      })
    },
    startupChecks () {
      startupWarnings(current())
      explore.warm()
    },
    close () {
      closing ??= (async () => {
        unsubscribe()
        const stopped = new Promise<void>(resolve => server.close(() => resolve()))
        // Media streams and status polls would hold close() open; nothing is mid-write that matters
        server.closeAllConnections()
        await Promise.all([stopped, hls.close(), engine.close()])
      })()
      return closing
    },
  }
}

/** Fail loudly at startup, not mid-playback: check the external binaries, and note missing indexers. */
function startupWarnings (c: Config): void {
  if (!c.sources.length) {
    console.warn('No sources configured: search will be empty. Add one in Settings → Sources, or set TORZNAB_URL, JACKETT_URL or PROWLARR_URL (see README).')
  }
  for (const [bin, varName] of [[c.ffprobePath, 'FFPROBE_PATH'], [c.ffmpegPath, 'FFMPEG_PATH']] as const) {
    execFile(bin, ['-version'], err => {
      if (err) console.warn(`"${bin}" not found: playback needs ffmpeg and ffprobe. Install them, or point ${varName} at the binary.`)
    })
  }
}
