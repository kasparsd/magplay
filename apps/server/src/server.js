import { logTail } from './logs.ts' // first, so it captures every log line
import http from 'node:http'
import { execFile } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import config, { settings } from './config.js'
import { HttpError, toHttpError } from './errors.ts'
import { createRouter, isSameOrigin, route, sendCached, serveFile } from '@magplay/http-kit'
import { SourceError } from './sources/release.js'
import { createSearch } from './search.js'
import { createSources } from './sources/index.js'
import { createBitmagnetBrowser, TYPES } from './sources/bitmagnet.js'
import { addTorrent, describe, getFile, getTorrent, knownWarning, recent, serveRaw, serveTar, status } from './torrents.js'
import { probe, decide, subtitleToVtt } from './media.js'
import { startSession, stopSession, stopTab, closeTab, touchSession, sessionStats, serveHls, stopAllSessions } from './sessions.js'
import { checkSource, debugInfo, status as statusChecks } from './status-checks.js'
import { serveSpeedtest } from './speedtest.ts'
import { sourceConfigs } from './sources/index.js'

const root = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(root, '../../..')
const publicDir = path.join(repoRoot, 'public')
const distDir = path.join(repoRoot, 'dist/client')
const CONTENT_TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.map': 'application/json' }

/** Serves a front-end file. Pages and scripts revalidate on every load, so a deploy shows up on reload. */
const file = target => ({ req, res }) => serveFile(req, res, target, `${CONTENT_TYPES[path.extname(target)]}; charset=utf-8`)
const page = name => file(path.join(publicDir, name))
// Page bundles are built by esbuild from apps/client into dist/client (see `npm run build`)
const asset = name => file(path.join(distDir, name))

const json = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(body))
}

async function readJson (req) {
  let body = ''
  for await (const chunk of req) {
    body += chunk
    if (body.length > 1e6) throw new HttpError(413, 'Request too large')
  }
  let parsed
  try { parsed = JSON.parse(body || '{}') } catch { throw new HttpError(400, 'Invalid JSON') }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new HttpError(400, 'Expected a JSON object')
  return parsed
}

const buildSearch = () => createSearch(createSources(config.sources), { timeoutMs: config.searchTimeoutMs })
let searcher = buildSearch()

// Fail loudly at startup, not mid-playback: check the external binaries, and note missing indexers
if (!config.sources.length) {
  console.warn('No sources configured: search will be empty. Add one in Settings → Sources, or set TORZNAB_URL, JACKETT_URL or PROWLARR_URL (see README).')
}
for (const [bin, varName] of [[config.ffprobePath, 'FFPROBE_PATH'], [config.ffmpegPath, 'FFMPEG_PATH']]) {
  execFile(bin, ['-version'], err => {
    if (err) console.warn(`"${bin}" not found: playback needs ffmpeg and ffprobe. Install them, or point ${varName} at the binary.`)
  })
}
let browser = config.bitmagnetUrl ? createBitmagnetBrowser({ url: config.bitmagnetUrl }) : null

// Explore answers are cached briefly: browsing goes back and forth over the same filters
const exploreCache = new Map()
function cached (key, load, ttl = 60_000) {
  const hit = exploreCache.get(key)
  if (hit && Date.now() - hit.at < ttl) return hit.value
  const value = load().catch(err => {
    exploreCache.delete(key)
    if (err.name === 'TimeoutError') throw new HttpError(504, 'BitMagnet took too long to answer. Try again in a moment.')
    if (err instanceof SourceError) throw new HttpError(502, err.message)
    throw err
  })
  exploreCache.set(key, { at: Date.now(), value })
  if (exploreCache.size > 200) exploreCache.delete(exploreCache.keys().next().value)
  return value
}

/** Explore's query parameters, checked: type, genre, year, res, sort, page. */
function exploreParams (query) {
  if (!browser) throw new HttpError(404, 'Explore needs BitMagnet. Set its address in Settings → Sources.')
  const type = query.get('type') || 'movie'
  if (!TYPES.includes(type)) throw new HttpError(400, 'type must be movie or tv_show')
  const genre = query.get('genre') || undefined
  const year = query.get('year') ? Number(query.get('year')) : undefined
  const resolution = query.get('res') || undefined
  if ((genre && !/^[\w:.-]+$/.test(genre)) || (year !== undefined && !Number.isInteger(year)) || (resolution && !/^V\d+p$/.test(resolution))) {
    throw new HttpError(400, 'Bad filter')
  }
  return { type, genre, year, resolution, sort: query.get('sort') === 'added' ? 'added' : 'seeders', page: Math.max(1, Number(query.get('page')) || 1) }
}

const exploreTimeout = (ms = config.searchTimeoutMs) => ({ signal: AbortSignal.timeout(ms) })
const FACETS_TTL = 15 * 60_000
const loadFacets = p => cached(`facets:${JSON.stringify(p)}`, () => browser.facets(p, exploreTimeout(120_000)), FACETS_TTL)
// Counts for the unfiltered tabs take a while on a big index, so start them now
const warmFacets = () => { if (browser) for (const type of TYPES) loadFacets({ type }).catch(err => console.log(`[explore] warming ${type} counts: ${err.message}`)) }
warmFacets()

// Saved settings apply without a restart: rebuild what was built from them
settings.on('changed', changed => {
  if (changed.includes('sources') || changed.includes('search.timeoutS')) searcher = buildSearch()
  if (changed.includes('sources') || changed.includes('explore.bitmagnetUrl')) {
    browser = config.bitmagnetUrl ? createBitmagnetBrowser({ url: config.bitmagnetUrl }) : null
    exploreCache.clear()
    warmFacets()
  }
})
const subtitleCache = new Map()

async function play (body, cancelled) {
  const { ih, tab, caps = {} } = body
  const idx = Number(body.idx)
  const audio = Number(body.audio ?? 0)
  const start = Number(body.start ?? 0)
  if (!Number.isInteger(idx) || idx < 0 || !Number.isInteger(audio) || audio < 0 || !Number.isFinite(start) || start < 0 ||
      !caps || typeof caps !== 'object' || Array.isArray(caps) || (tab !== undefined && typeof tab !== 'string')) {
    throw new HttpError(400, 'Invalid playback options')
  }
  const check = () => { if (cancelled()) throw new HttpError(499, 'Playback request cancelled') }
  check()
  const file = await getFile(ih, idx)
  check()
  const info = await probe(ih, idx, file.name)
  check()
  let decision
  try {
    decision = decide(info, caps, audio)
  } catch (err) {
    console.log(`[play] refused ${ih}/${idx} ${file.name}: ${err.message}`)
    throw err
  }
  console.log(`[play] ${decision.mode} ${ih}/${idx} ${file.name} @${start.toFixed(0)}s: ${decision.reason}`)
  const out = { ...decision, duration: info.duration }
  if (decision.mode === 'direct') {
    stopTab(tab)
    return { ...out, url: `/raw/${ih}/${idx}`, offset: 0 }
  }
  const s = startSession({ ih, idx, info, audio, start, mode: decision.mode, tab })
  return {
    ...out,
    url: `/hls/${s.id}/index.m3u8`,
    session: s.id,
    offset: start,
    // Text subtitles are written by the same ffmpeg, timed relative to the session start
    subtitles: info.subtitles.filter(t => t.text).map(t => ({ index: t.index, url: `/hls/${s.id}/sub_${t.index}.vtt` })),
  }
}

/** An .m3u for external players: one file, or every video in the torrent (a season) when idx is omitted. */
async function playlist (req, res, ih, idx) {
  if (!/^[a-f0-9]{40}$/.test(ih ?? '')) throw new HttpError(400, 'Bad info hash')
  const torrent = await addTorrent({ infoHash: ih })
  const files = describe(torrent).files.filter(f => idx == null ? f.isVideo : f.idx === Number(idx))
  if (!files.length) throw new HttpError(404, 'No video files')
  // Links must use the address the browser reached us on, never 127.0.0.1
  const origin = `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers['x-forwarded-host'] || req.headers.host}`
  const base = name => name.split('/').pop()
  const lines = ['#EXTM3U', ...files.flatMap(f => [`#EXTINF:-1,${base(f.name)}`, `${origin}/raw/${ih}/${f.idx}/${encodeURIComponent(base(f.name))}`])]
  const title = (idx == null ? torrent.name : base(files[0].name)).replace(/[^\w.-]+/g, '_')
  res.writeHead(200, {
    'Content-Type': 'audio/x-mpegurl; charset=utf-8',
    'Content-Disposition': `attachment; filename="${title}.m3u"`,
  })
  res.end(lines.join('\n') + '\n')
}

async function subtitles ({ req, res, params }) {
  // Embedded track N (reads the whole file, so used for direct play only) or "file" for an external subtitle file
  const track = params.track.replace(/\.vtt$/, '')
  if (!/^(\d+|file)$/.test(track)) throw new HttpError(404, 'Not found')
  const key = `${params.ih}/${params.idx}/${track}`
  if (!subtitleCache.has(key)) {
    const job = (async () => {
      await getFile(params.ih, Number(params.idx))
      return subtitleToVtt(params.ih, Number(params.idx), track === 'file' ? null : Number(track))
    })()
    job.catch(() => subtitleCache.delete(key))
    subtitleCache.set(key, job)
  }
  const text = await subtitleCache.get(key)
  sendCached(req, res, text, { 'Content-Type': 'text/vtt; charset=utf-8' })
}

async function searchRoute ({ res, query }) {
  if (!query.get('q')?.trim()) throw new HttpError(400, 'Type something to search for')
  const out = await searcher.search(query.get('q').trim(), query.get('cat'))
  for (const r of out.results) {
    const warning = r.infoHash && knownWarning(r.infoHash)
    if (warning) Object.assign(r, { warning, likelyDirect: false })
  }
  json(res, 200, out)
}

async function addRoute ({ req, res }) {
  const { infoHash, magnet, linkId } = await readJson(req)
  const link = linkId ? searcher.linkFor(linkId) : null
  if (linkId && !link) throw new HttpError(410, 'This search result has expired. Search again.')
  json(res, 200, describe(await addTorrent({ infoHash, magnet, link })))
}

async function probeRoute ({ req, res, params }) {
  const torrent = await getTorrent(params.ih)
  const file = torrent.files[Number(params.idx)]
  if (!file) throw new HttpError(404, 'No such file in this torrent')
  const info = await probe(params.ih, Number(params.idx), file.name)
  const { files } = describe(torrent)
  sendCached(req, res, JSON.stringify({ ...info, externalSubtitles: files.filter(f => f.isSub).map(f => ({ idx: f.idx, name: f.name })) }), { 'Content-Type': 'application/json' })
}

/** Torrent activity; the player adds idx (its file) and session/pos (its ffmpeg session, kept alive by this poll). */
function statusRoute ({ res, params, query }) {
  const out = status(params.ih, { idx: query.has('idx') ? Number(query.get('idx')) : undefined })
  const s = query.get('session') && touchSession(query.get('session'), Number(query.get('pos')))
  json(res, 200, { ...out, session: s ? sessionStats(s) : null })
}

/** Writes change the server for everyone, so only this site's own pages may make them. */
function sameOriginOnly (req) {
  if (!isSameOrigin(req)) throw new HttpError(403, 'Settings can only be changed from magplay’s own pages.')
}

async function patchSettings ({ req, res }) {
  sameOriginOnly(req)
  const result = settings.update(await readJson(req))
  if (!result.ok) return json(res, 400, { error: 'Some settings aren’t valid.', fields: result.fields })
  json(res, 200, settings.response())
}

async function testSetting ({ req, res }) {
  sameOriginOnly(req)
  const { key, item } = await readJson(req)
  if (key !== 'sources' || !item || typeof item !== 'object') throw new HttpError(400, 'Only sources can be tested')
  const checked = settings.unsavedItem(key, item)
  if (!checked.ok) return json(res, 200, { level: 'error', value: 'Invalid', message: checked.error })
  json(res, 200, await checkSource(sourceConfigs([checked.item])[0]))
}

const match = createRouter([
  // Pages
  route('GET', '/', page('index.html')),
  route('GET', '/t/:ih?', page('torrent.html')),
  route('GET', '/play/:ih/:idx', page('player.html')),
  route('GET', '/explore', page('explore.html')),
  route('GET', '/title/:type/:source/:id', page('title.html')),
  route('GET', '/settings', page('settings.html')),
  route('GET', '/player.html', ({ res, query }) => { // links from before /play existed
    res.writeHead(301, { Location: `/play/${query.get('ih')}/${query.get('idx')}` })
    res.end()
  }),
  route('GET', '/style.css', page('style.css')),
  ...['search.js', 'torrent.js', 'player.js', 'explore.js', 'title.js', 'settings.js'].flatMap(name => [route('GET', `/${name}`, asset(name)), route('GET', `/${name}.map`, asset(`${name}.map`))]),
  route('GET', '/health', ({ res }) => json(res, 200, { ok: true })),

  // API
  route('GET', '/api/status', async ({ res }) => json(res, 200, await statusChecks.snapshot())),
  route('GET', '/api/settings', ({ res }) => json(res, 200, settings.response())),
  route('PATCH', '/api/settings', patchSettings),
  route('POST', '/api/settings/test', testSetting),
  route('GET', '/api/debug', async ({ res }) => json(res, 200, await debugInfo(logTail()))),
  route('POST', '/api/debug/clear-hls', ({ req, res }) => {
    sameOriginOnly(req)
    const stopped = stopAllSessions()
    console.log(`[debug] cleared the conversion cache, stopped ${stopped} session(s)`)
    json(res, 200, { stopped })
  }),
  route('GET', '/api/speedtest', ({ req, res }) => serveSpeedtest(req, res)),
  route('GET', '/api/search', searchRoute),
  route('GET', '/api/recent', async ({ res }) => json(res, 200, await recent())),
  route('GET', '/api/explore', async ({ res, query }) => {
    const p = exploreParams(query)
    json(res, 200, await cached(JSON.stringify(p), () => browser.browse(p, exploreTimeout())))
  }),
  route('GET', '/api/explore/facets', async ({ res, query }) => {
    const { type, genre, year, resolution } = exploreParams(query)
    json(res, 200, await loadFacets({ type, genre, year, resolution }))
  }),
  route('GET', '/api/explore/latest', async ({ res, query }) => {
    const { type } = exploreParams(query)
    json(res, 200, await cached(`latest:${type}`, () => browser.latest({ type }, exploreTimeout())))
  }),
  route('GET', '/api/title/:type/:source/:id', async ({ res, params, query }) => {
    if (!browser) throw new HttpError(404, 'Explore needs BitMagnet. Set its address in Settings → Sources.')
    if (!TYPES.includes(params.type)) throw new HttpError(400, 'type must be movie or tv_show')
    const t = await cached(`title:${params.type}:${params.source}:${params.id}`, () =>
      browser.title({ ...params, title: query.get('title'), year: query.get('year') }, exploreTimeout()))
    if (!t) throw new HttpError(404, 'No releases of this title found any more.')
    json(res, 200, t)
  }),
  route('POST', '/api/torrents', addRoute),
  route('GET', '/api/torrents/:ih', async ({ res, params }) => json(res, 200, describe(await getTorrent(params.ih)))),
  route('GET', '/api/torrents/:ih/status', statusRoute),
  route('GET', '/api/probe/:ih/:idx', probeRoute),
  route('POST', '/api/play', async ({ req, res }) => json(res, 200, await play(await readJson(req), () => res.destroyed))),
  route('POST', '/api/play/tab/:tab', ({ res, params }) => {
    closeTab(params.tab)
    json(res, 200, { ok: true })
  }),
  route('DELETE|POST', '/api/play/:session', ({ res, params }) => { // POST too, for navigator.sendBeacon
    stopSession(params.session)
    json(res, 200, { ok: true })
  }),

  // Media
  // An optional trailing file name lets external players show a title and guess the format
  route('GET|HEAD', '/raw/:ih/:idx/:name?', ({ req, res, params, query }) => serveRaw(req, res, params.ih, Number(params.idx), { download: query.has('download') })),
  route('GET|HEAD', '/tar/:ih/:name?', ({ req, res, params }) => serveTar(req, res, params.ih)),
  route('GET', '/playlist.m3u', ({ req, res, query }) => playlist(req, res, query.get('ih'), query.get('idx'))),
  route('GET', '/hls/:session/:file', ({ req, res, params }) => serveHls(res, params.session, params.file, req)),
  route('GET', '/subs/:ih/:idx/:track', subtitles),
])

const server = http.createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store') // Safe default for live APIs, mutations, redirects and errors.
  let url
  try {
    try { url = new URL(req.url, 'http://localhost') } catch { throw new HttpError(400, 'Malformed URL') }
    const found = match(req.method, url.pathname) || (req.method === 'HEAD' && match('GET', url.pathname))
    if (!found) throw new HttpError(404, 'Not found')
    await found.handler({ req, res, params: found.params, query: url.searchParams })
  } catch (err) {
    const failure = toHttpError(err)
    if (failure.unexpected) console.error(`[http] ${req.method} ${url?.pathname ?? req.url}:`, err)
    if (res.destroyed) return
    if (res.headersSent) return res.destroy()
    if (failure.retryAfter) res.setHeader('Retry-After', String(failure.retryAfter))
    json(res, failure.status, { error: failure.message })
  }
})
server.requestTimeout = 0 // /raw streams stay open for as long as playback needs
server.listen(config.port, () => console.log(`magplay listening on :${config.port}, sources: ${config.sources.map(c => `${c.name} (${c.type} ${c.url})`).join(', ')}`))
