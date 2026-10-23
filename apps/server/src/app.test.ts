import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { TIMELINE_OFFSET } from '@magplay/playback'
import type { FfmpegProcess } from '@magplay/playback'
import { createApp } from './app.ts'
import type { App, AppOptions } from './app.ts'
import { loadConfig } from './config.ts'

type Env = Record<string, string>

// Minimal fragmented MP4: an init segment with a video track (timescale 1000), and fragments starting at a time
const u32 = (n: number): number[] => [n >>> 24 & 0xff, n >>> 16 & 0xff, n >>> 8 & 0xff, n & 0xff]
const box = (type: string, ...body: number[][]): number[] => { const data = body.flat(); return [...u32(8 + data.length), ...[...type].map(c => c.charCodeAt(0)), ...data] }
const fullBox = (type: string, ...body: number[][]): number[] => box(type, [0, 0, 0, 0], ...body)
const initSegment = (): Buffer => Buffer.from([...box('ftyp', u32(0)), ...box('moov', box('trak', fullBox('tkhd', u32(0), u32(0), u32(1)), box('mdia', fullBox('mdhd', u32(0), u32(0), u32(1000), u32(0)), fullBox('hdlr', u32(0), [...'vide'].map(c => c.charCodeAt(0))))))])
const fragment = (seconds: number): Buffer => Buffer.from([...box('moof', box('traf', fullBox('tfhd', u32(1)), fullBox('tfdt', u32(seconds * 1000)))), ...box('mdat', [0])])

/** An app on a free port with an isolated cache, no DHT/LSD and an unreachable indexer. */
async function start (t: { after: (fn: () => Promise<void>) => void }, env: Env = {}, options: Partial<AppOptions> = {}): Promise<{ app: App, origin: string, dir: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'magplay-app-'))
  const config = loadConfig({ CACHE_DIR: dir, TORRENT_PORT: '0', DHT_ENABLED: 'off', LSD_ENABLED: 'off', EXTRA_TRACKERS: '', TORZNAB_URL: 'http://127.0.0.1:1/feed', ...env })
  const app = createApp({ config, ...options })
  const port = await app.listen(0)
  t.after(async () => {
    await app.close()
    await fs.rm(dir, { recursive: true, force: true })
  })
  return { app, origin: `http://127.0.0.1:${port}`, dir }
}

const errorBody = async (res: Response): Promise<unknown> => ((await res.json()) as { error?: unknown }).error

test('HTTP server serves pages and modules, rejects bad routes and remains healthy', { timeout: 20_000 }, async t => {
  const { origin } = await start(t)
  const pages = ['/', '/t/', '/play/ih/0', '/explore', '/title/movie/tmdb/1', '/settings']
  const assets = new Set<string>()
  for (const url of pages) {
    const html = await (await fetch(origin + url)).text()
    for (const [, asset] of html.matchAll(/(?:src|href)="(\/[^"]+\.(?:js|css))"/g)) assets.add(asset!)
  }
  // Every page is the one shell; every script and stylesheet it links is content-hashed, so a release changes its URL
  assert.equal(assets.size, 2)
  for (const asset of assets) assert.match(asset, /^\/assets\/[\w-]+-[\w-]{8}\.(?:js|css)$/)
  for (const url of [...pages, ...assets, `${[...assets].find(asset => asset.endsWith('.js'))}.map`]) {
    const res = await fetch(origin + url)
    assert.equal(res.status, 200, url)
    assert.equal(res.headers.get('cache-control'), url.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache', url)
    const etag = res.headers.get('etag')
    assert.ok(etag)
    if (!url.startsWith('/assets/')) assert.doesNotMatch(etag, /^W\//, 'page validators hash the content')
    const length = res.headers.get('content-length')
    assert.ok((await res.text()).length > 0, url)
    const cached = await fetch(origin + url, { headers: { 'If-None-Match': `"old", ${etag.replace(/^W\//, '')}` } })
    assert.equal(cached.status, 304)
    assert.equal(await cached.text(), '')
    assert.equal(cached.headers.get('etag'), etag)
    const head = await fetch(origin + url, { method: 'HEAD' })
    assert.equal(head.status, 200)
    assert.equal(head.headers.get('content-length'), length)
    assert.equal(await head.text(), '')
  }
  for (const [url, status] of [['/t/%ZZ', 400], ['/playlistXm3u', 404], ['/search.js', 404], ['/style.css', 404], ['/index.html', 404], ['/src/search.js', 404], ['/src/style.css', 404], ['/assets/search.js', 404], ['/assets/..%2Fexplore.html', 404], ['/api/search', 400], ['/api/torrents/bad', 400], ['/api/explore', 404], ['/lib/api.js', 404], ['/lib/api-types.js', 404], ['/vendor/hls.min.js', 404], ['/lib/api.test.js', 404], ['/lib/requests.test.js', 404], ['/lib/capabilities.test.js', 404], ['/lib/subtitles.test.js', 404], ['/lib/progress.test.js', 404]] as const) {
    const res = await fetch(origin + url)
    assert.equal(res.status, status, url)
    assert.equal(res.headers.get('cache-control'), 'no-store')
    assert.equal(typeof await errorBody(res), 'string')
  }
  for (const body of ['null', '[]', '"string"', '{', '{"caps":null}', '{"start":"Infinity"}', '{"audio":-1}']) {
    const res = await fetch(`${origin}/api/play`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
    assert.equal(res.status, 400, body)
    assert.equal(res.headers.get('cache-control'), 'no-store')
    assert.equal(typeof await errorBody(res), 'string')
  }
  for (const url of ['/health', '/api/recent', '/hls/missing/index.m3u8', '/hls/missing/seg_00000.m4s']) {
    const res = await fetch(origin + url, { headers: { 'If-None-Match': '*' } })
    assert.notEqual(res.status, 304)
    assert.equal(res.headers.get('cache-control'), 'no-store')
  }
  const redirect = await fetch(origin + '/player.html?ih=abc&idx=0', { redirect: 'manual' })
  assert.equal(redirect.status, 301)
  assert.equal(redirect.headers.get('cache-control'), 'no-store')
  assert.equal((await fetch(`${origin}/health`).then(r => r.json()) as { ok: boolean }).ok, true)
})

test('typed failures keep their statuses: unknown torrents, expired links, Retry-After on busy work', async t => {
  const { origin } = await start(t, { MAX_TORRENT_LOADS: '1', METADATA_TIMEOUT_S: '30' })
  const post = (body: unknown) => fetch(`${origin}/api/torrents`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  assert.equal((await post({})).status, 400)
  assert.equal((await post({ magnet: 'not a magnet' })).status, 400)
  const expired = await post({ linkId: 'unknown' })
  assert.equal(expired.status, 410)
  assert.match(String(await errorBody(expired)), /expired/)
  // One slow load fills the only slot: the next is a 503 to retry, not a queue
  const slow = post({ infoHash: '1'.repeat(40) })
  await new Promise(resolve => setTimeout(resolve, 100))
  const busy = await post({ infoHash: '2'.repeat(40) })
  assert.equal(busy.status, 503)
  assert.equal(busy.headers.get('retry-after'), '5')
  slow.catch(() => {}) // ended by close()
})

test('saved live settings reach the running services without a restart', async t => {
  const { origin } = await start(t)
  const patch = (body: unknown) => fetch(`${origin}/api/settings`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' }, body: JSON.stringify(body) })
  assert.equal((await fetch(`${origin}/api/explore`)).status, 404)
  assert.equal((await patch({ 'explore.bitmagnetUrl': 'http://127.0.0.1:1' })).status, 200)
  // Explore exists now; BitMagnet itself is unreachable, which is a 502 from the source
  assert.equal((await fetch(`${origin}/api/explore`)).status, 502)
  const debug = await fetch(`${origin}/api/debug`).then(r => r.json()) as { resources: Array<{ id: string, limit: number }> }
  assert.equal(debug.resources.find(r => r.id === 'hls')?.limit, 8 * 1024 ** 3)
  await patch({ 'cache.hlsMaxGb': 5 })
  const after = await fetch(`${origin}/api/debug`).then(r => r.json()) as { resources: Array<{ id: string, limit: number }> }
  assert.equal(after.resources.find(r => r.id === 'hls')?.limit, 5 * 1024 ** 3)
})

test('graceful shutdown: close() ends open streams, stops ffmpeg, frees the port and the torrent engine', { timeout: 20_000 }, async t => {
  const signals: string[] = []
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const media = new PassThrough()
  const proc = Object.assign(new EventEmitter(), {
    pid: 1, stdout, stderr, stdio: [null, stdout, stderr, media], kill: (signal: string) => { signals.push(signal); return true },
  }) as unknown as FfmpegProcess
  const { app, origin, dir } = await start(t, {}, { spawnProcess: () => proc })

  // A long download holds a connection open; close() must not wait for it
  const download = await fetch(`${origin}/api/speedtest`)
  const reader = download.body!.getReader()
  await reader.read()
  const drained = (async () => {
    try {
      while (!(await reader.read()).done);
    } catch {}
  })()

  // A paused (SIGSTOPped) ffmpeg would outlive the server; close() must resume and kill it
  const session = app.hls.start({ input: `${origin}/raw/x/0`, info: { duration: 600, startTime: 0, audio: [], subtitles: [] }, audio: 0, start: 0, mode: 'remux', keyframes: [0, 300] })
  media.write(Buffer.concat([initSegment(), fragment(TIMELINE_OFFSET), fragment(TIMELINE_OFFSET + 300)])) // far ahead of the player
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(session.paused, true)
  t.mock.method(console, 'log', () => {})

  const started = Date.now()
  await app.close()
  await drained
  assert.ok(Date.now() - started < 5000, 'close() waited for the open stream')
  assert.equal(app.server.listening, false)
  await assert.rejects(fetch(`${origin}/health`))
  assert.deepEqual(signals, ['SIGSTOP', 'SIGCONT', 'SIGKILL'])
  assert.deepEqual(await fs.readdir(path.join(dir, 'hls')), [])
  assert.equal(await app.close(), undefined) // twice is fine
})

test('close() does not wait for a search stuck on a silent indexer or a torrent still looking for peers', { timeout: 20_000 }, async t => {
  const http = await import('node:http')
  // An indexer that accepts the connection and never answers
  const silent = http.createServer(() => {})
  await new Promise<void>(resolve => silent.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise<void>(resolve => { silent.closeAllConnections(); silent.close(() => resolve()) }))
  const address = silent.address()
  const indexer = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/api`
  const { app, origin } = await start(t, { TORZNAB_URL: indexer, SEARCH_TIMEOUT_S: '60' })
  t.mock.method(console, 'log', () => {})

  const search = fetch(`${origin}/api/search?q=anything`).catch((err: unknown) => err)
  const load = fetch(`${origin}/api/torrents`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ infoHash: '3'.repeat(40) }) }).catch((err: unknown) => err)
  await new Promise(resolve => setTimeout(resolve, 200))
  assert.equal((await fetch(`${origin}/health`)).status, 200)

  const started = Date.now()
  await app.close()
  assert.ok(Date.now() - started < 5000, 'close() waited for in-flight work')
  // Both requests end (their connections are closed) instead of hanging until their own timeouts
  assert.ok(await search instanceof Error)
  assert.ok(await load instanceof Error)
  assert.equal(app.server.listening, false)
})

test('structured request outcomes and private metrics are bounded and correlated', async t => {
  const { createLogging } = await import('@magplay/observability')
  const logging = createLogging({ level: 'debug', sink: { write () {} } })
  const { app, origin } = await start(t, {}, { logging })
  const port = await app.listenMetrics(0, '127.0.0.1')
  const response = await fetch(`${origin}/missing?token=hidden`, { headers: { 'X-Request-Id': 'untrusted-secret' } })
  await response.text()
  const requestId = response.headers.get('x-request-id')
  assert.ok(requestId && requestId !== 'untrusted-secret')
  const records = logging.tail().filter(l => l.requestId === requestId)
  assert.equal(records.length, 1)
  assert.equal(records[0]?.route, 'unmatched')
  assert.equal(records[0]?.status, 404)
  assert.doesNotMatch(JSON.stringify(records), /hidden|untrusted-secret|missing/)
  const scraped = await fetch(`http://127.0.0.1:${port}/metrics`)
  assert.match(scraped.headers.get('content-type') ?? '', /text\/plain/)
  assert.equal(scraped.headers.get('cache-control'), 'no-store')
  assert.match(await scraped.text(), /magplay_http_requests_total\{group="other",method="GET",status_class="4xx"\} 1/)
  assert.equal((await fetch(`${origin}/metrics`)).status, 404)
  assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status, 404)
  await app.close()
  await assert.rejects(fetch(`http://127.0.0.1:${port}/metrics`))
})
