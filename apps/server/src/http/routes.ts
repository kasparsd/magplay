// The HTTP API and media routes. Handlers parse requests, call services and send api-contract shapes.
import { noopLogger } from '@magplay/observability'
import type { Logger } from '@magplay/observability'
import type { IncomingMessage } from 'node:http'
import { isSameOrigin, route, sendCached } from '@magplay/http-kit'
import type { Route } from '@magplay/http-kit'
import type { HlsSessions } from '@magplay/playback'
import type { TorrentEngine } from '@magplay/torrent-engine'
import type {
  DebugInfo, ExploreFacets, ExploreResponse, LatestRelease, PlaybackDecision, ProbeResult, RecentTorrent, SearchResponse, SettingsErrorResponse,
  SettingsResponse, StatusCheck, StatusResponse, TitleResponse, TorrentInfo, TorrentStatus,
} from '@magplay/api-contract'
import { sourceConfigs } from '../config.ts'
import type { SettingsStore } from '../settings-store.ts'
import type { Explore } from '../services/explore.ts'
import type { Play } from '../services/play.ts'
import { playlist } from '../services/playlists.ts'
import type { SearchService } from '../services/search.ts'
import { checkSource } from '../services/status-checks.ts'
import type { StatusChecks } from '../services/status-checks.ts'
import type { StatusRegistry } from '../services/status.ts'
import { addTorrent } from '../services/torrents.ts'
import type { Tabs } from '../services/tabs.ts'
import { HttpError } from './errors.ts'
import { serveHls } from './hls.ts'
import { serveRaw, serveTar } from './media.ts'
import { json, parseAddRequest, parsePlayRequest, readJson } from './request.ts'
import { serveSpeedtest } from './speedtest.ts'

export interface RouteDeps {
  logger?: Logger
  requestLogger?: (req: IncomingMessage) => Logger
  engine: TorrentEngine
  hls: HlsSessions
  tabs: Tabs
  play: Play
  search: SearchService
  explore: Explore
  subtitles: { vtt: (ih: string, idx: number, track: string) => Promise<string> }
  settings: SettingsStore
  status: StatusRegistry
  checks: StatusChecks
}

/** Writes change the server for everyone, so only this site's own pages may make them. */
function sameOriginOnly (req: IncomingMessage): void {
  if (!isSameOrigin(req)) throw new HttpError(403, 'Settings can only be changed from magplay’s own pages.')
}

/** The address the browser reached us on, for links in playlists; never 127.0.0.1 behind a proxy. */
const requestOrigin = (req: IncomingMessage): string =>
  `${String(req.headers['x-forwarded-proto'] ?? 'http')}://${String(req.headers['x-forwarded-host'] ?? req.headers.host)}`

const index = (value: string): number => Number(value)

export function apiRoutes ({ engine, hls, tabs, play, search, explore, subtitles, settings, status, checks, logger = noopLogger, requestLogger = () => logger }: RouteDeps): Route[] {
  return [

    // Settings, status and debugging
    route('GET', '/api/status', async ({ res }) => json<StatusResponse>(res, 200, await status.snapshot())),
    route('GET', '/api/settings', ({ res }) => json<SettingsResponse>(res, 200, settings.response())),
    route('PATCH', '/api/settings', async ({ req, res }) => {
      sameOriginOnly(req)
      const result = settings.update(await readJson(req))
      if (!result.ok) return json<SettingsErrorResponse>(res, 400, { error: 'Some settings aren’t valid.', fields: result.fields })
      json<SettingsResponse>(res, 200, settings.response())
    }),
    route('POST', '/api/settings/test', async ({ req, res }) => {
      sameOriginOnly(req)
      const { key, item } = await readJson(req)
      if (key !== 'sources' || !item || typeof item !== 'object' || Array.isArray(item)) throw new HttpError(400, 'Only sources can be tested')
      const checked = settings.unsavedItem(key, item as Record<string, unknown>)
      if (!checked.ok) return json<Pick<StatusCheck, 'level' | 'value' | 'message'>>(res, 200, { level: 'error', value: 'Invalid', message: checked.error })
      json<Pick<StatusCheck, 'level' | 'value' | 'message' | 'action'>>(res, 200, await checkSource(sourceConfigs([checked.item])[0]!))
    }),
    route('GET', '/api/debug', async ({ res }) => json<DebugInfo>(res, 200, await checks.debugInfo())),
    route('POST', '/api/debug/clear-hls', ({ req, res }) => {
      sameOriginOnly(req)
      const stopped = hls.stopAll()
      logger.info('hls.cache.cleared', { count: stopped })
      json(res, 200, { stopped })
    }),
    route('GET', '/api/speedtest', ({ req, res }) => serveSpeedtest(req, res)),

    // Search and Explore
    route('GET', '/api/search', async ({ req, res, query }) => json<SearchResponse>(res, 200, await search.search(query.get('q'), query.get('cat'), { logger: requestLogger(req) }))),
    route('GET', '/api/recent', async ({ res }) => json<RecentTorrent[]>(res, 200, await engine.recent())),
    route('GET', '/api/explore', async ({ res, query }) => json<ExploreResponse>(res, 200, await explore.browse(explore.params(query)))),
    route('GET', '/api/explore/facets', async ({ res, query }) => json<ExploreFacets>(res, 200, await explore.facets(explore.params(query)))),
    route('GET', '/api/explore/latest', async ({ res, query }) => json<LatestRelease[]>(res, 200, await explore.latest(explore.params(query)))),
    route('GET', '/api/title/:type/:source/:id', async ({ res, params, query }) =>
      json<TitleResponse>(res, 200, await explore.title(params.type, params.source, params.id, query))),

    // Torrents and playback
    route('POST', '/api/torrents', async ({ req, res }) => json<TorrentInfo>(res, 200, await addTorrent(engine, search, parseAddRequest(await readJson(req))))),
    route('GET', '/api/torrents/:ih', async ({ res, params }) => json<TorrentInfo>(res, 200, engine.describe(await engine.get(params.ih)))),
    /** Torrent activity; the player adds idx (its file) and session/pos (its ffmpeg session, kept alive by this poll). */
    route('GET', '/api/torrents/:ih/status', ({ res, params, query }) => {
      const out = engine.status(params.ih, { idx: query.has('idx') ? Number(query.get('idx')) : undefined })
      const id = query.get('session')
      const s = id ? hls.touch(id, Number(query.get('pos'))) : null
      json<TorrentStatus>(res, 200, { ...out, preparation: query.has('idx') ? play.preparation(params.ih, Number(query.get('idx'))) : null, session: s ? hls.stats(s) : null })
    }),
    route('GET', '/api/probe/:ih/:idx', async ({ req, res, params }) => {
      const info: ProbeResult = await play.probe(params.ih, index(params.idx), { logger: requestLogger(req) })
      sendCached(req, res, JSON.stringify(info), { 'Content-Type': 'application/json' })
    }),
    route('POST', '/api/play', async ({ req, res }) =>
      json<PlaybackDecision>(res, 200, await play.play(parsePlayRequest(await readJson(req)), () => res.destroyed, { logger: requestLogger(req) }))),
    route('POST', '/api/play/tab/:tab', ({ res, params }) => {
      tabs.close(params.tab)
      json(res, 200, { ok: true })
    }),
    route('DELETE|POST', '/api/play/:session', ({ res, params }) => { // POST too, for navigator.sendBeacon
      hls.stop(params.session)
      json(res, 200, { ok: true })
    }),

    // Media
    // An optional trailing file name lets external players show a title and guess the format
    route('GET|HEAD', '/raw/:ih/:idx/:name?', ({ req, res, params, query }) => serveRaw(req, res, engine, params.ih, index(params.idx), { download: query.has('download') })),
    route('GET|HEAD', '/tar/:ih/:name?', ({ req, res, params }) => serveTar(req, res, engine, params.ih)),
    route('GET', '/playlist.m3u', async ({ req, res, query }) => {
      const { filename, body } = await playlist(engine, requestOrigin(req), query.get('ih'), query.get('idx'))
      res.writeHead(200, { 'Content-Type': 'audio/x-mpegurl; charset=utf-8', 'Content-Disposition': `attachment; filename="${filename}"` })
      res.end(body)
    }),
    route('GET', '/hls/:session/:file', ({ req, res, params }) => serveHls(req, res, hls, params.session, params.file)),
    route('GET', '/subs/:ih/:idx/:track', async ({ req, res, params }) => {
      const text = await subtitles.vtt(params.ih, index(params.idx), params.track)
      sendCached(req, res, text, { 'Content-Type': 'text/vtt; charset=utf-8' })
    }),
  ]
}
