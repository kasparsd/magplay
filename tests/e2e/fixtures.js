import { test as base, expect } from '@playwright/test'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs/promises'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import { prepareCachedMedia } from '../fixtures/media.js'

const exec = promisify(execFile)
const root = path.resolve(import.meta.dirname, '../..')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function freePort () {
  const server = net.createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}

async function startApp () {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'magplay-browser-'))
  let proc
  let indexer
  let logs = ''
  const close = async () => {
    if (proc && proc.exitCode === null && proc.signalCode === null) {
      const exited = once(proc, 'exit')
      proc.kill('SIGTERM')
      const kill = setTimeout(() => proc.kill('SIGKILL'), 5000)
      await exited
      clearTimeout(kill)
    }
    if (indexer?.listening) await new Promise(resolve => indexer.close(resolve))
    await fs.rm(dir, { recursive: true, force: true })
  }
  try {
    await exec('ffprobe', ['-version'])
    const { ih, cache, files, length } = await prepareCachedMedia(dir)
    indexer = http.createServer((req, res) => {
      if (new URL(req.url, 'http://x').searchParams.get('t') === 'caps') { // the status check
        res.writeHead(200, { 'Content-Type': 'application/xml' })
        return res.end('<?xml version="1.0"?><caps><searching><search available="yes"/></searching></caps>')
      }
      res.writeHead(200, { 'Content-Type': 'application/rss+xml' })
      res.end(`<?xml version="1.0"?><rss version="2.0" xmlns:torznab="http://torznab.com/schemas/2015/feed"><channel><title>Local fixtures</title><item><title>Playback fixtures</title><guid>${ih}</guid><link>magnet:?xt=urn:btih:${ih}</link><size>${length}</size><torznab:attr name="infohash" value="${ih}"/><torznab:attr name="seeders" value="1"/></item></channel></rss>`)
    })
    indexer.listen(0, '127.0.0.1')
    await once(indexer, 'listening')
    const port = await freePort()
    const origin = `http://127.0.0.1:${port}`
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      !/^(TORZNAB_|JACKETT_|PROWLARR_|BITMAGNET_|EXTRA_TRACKERS|ALLOW_VIDEO_TRANSCODE)/.test(key)))
    proc = spawn(process.execPath, ['apps/server/src/main.ts'], {
      cwd: root,
      env: {
        ...env,
        PORT: String(port),
        TORRENT_PORT: '0',
        CACHE_DIR: cache,
        TORZNAB_URL: `http://127.0.0.1:${indexer.address().port}/feed`,
        EXTRA_TRACKERS: '',
        ALLOW_VIDEO_TRANSCODE: 'false',
        DHT_ENABLED: 'false',
        LSD_ENABLED: 'false',
        METADATA_TIMEOUT_S: '5'
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    proc.stdout.on('data', chunk => { logs += chunk })
    proc.stderr.on('data', chunk => { logs += chunk })
    proc.on('error', err => { logs += err.stack })
    for (let i = 0; ; i++) {
      if (proc.exitCode !== null) throw new Error(`Server exited:\n${logs}`)
      if (await fetch(`${origin}/health`).then(r => r.ok, () => false)) break
      if (i === 100) throw new Error(`Server did not start:\n${logs}`)
      await sleep(50)
    }
    return {
      origin,
      ih,
      files,
      cache,
      close,
      logs: () => logs,
      player: name => `${origin}/play/${ih}/${files[name]}`,
      torrent: `${origin}/t/${ih}`,
    }
  } catch (err) {
    await close()
    throw err
  }
}

export const test = base.extend({
  app: [async ({}, use) => { // eslint-disable-line no-empty-pattern -- Playwright requires a destructured first argument
    const app = await startApp()
    try { await use(app) } finally { await app.close() }
  }, { scope: 'worker' }],
  page: async ({ page, app }, use, testInfo) => {
    const errors = []
    page.on('pageerror', err => errors.push(err.message))
    // The application/indexer/bytes are local. Fail unexpected browser network
    // dependencies instead of allowing a fixture test to use the internet.
    await page.route('**/*', route => {
      const url = new URL(route.request().url())
      return url.origin === app.origin ? route.continue() : route.abort('blockedbyclient')
    })
    try {
      await use(page)
      expect(errors, 'uncaught browser errors').toEqual([])
    } finally {
      if (testInfo.status !== testInfo.expectedStatus) {
        await testInfo.attach('server.log', { body: app.logs(), contentType: 'text/plain' })
      }
      // A browser context being forcibly disposed is not a user navigation and
      // need not deliver pagehide/beacons. Navigate away, then clean up through
      // the real API so tests never inherit another test's HLS sessions.
      if (!page.isClosed()) await page.goto(app.origin).catch(() => {})
      for (const id of await fs.readdir(path.join(app.cache, 'hls'))) {
        await page.request.delete(`${app.origin}/api/play/${id}`)
      }
      await expect.poll(async () => (await fs.readdir(path.join(app.cache, 'hls'))).length).toBe(0)
    }
  },
})
export { expect }
