// Capture README screenshots (desktop + mobile, side by side) against a local
// fake Torznab feed. Search results list only Creative Commons and public
// domain films; the player plays a clip of Big Buck Bunny (CC BY 3.0, Blender Foundation).
// Usage: npm run build && node tools/scripts/screenshots.mjs path/to/big_buck_bunny_720p_h264.mov
import { chromium } from '@playwright/test'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import createTorrent from 'create-torrent'
import parseTorrent from 'parse-torrent'

const exec = promisify(execFile)
const root = path.resolve(import.meta.dirname, '../..')
const out = path.join(root, 'docs/screenshots')
const GB = 1024 ** 3

// Blender open movies (CC BY) and US public domain films; titles only, never downloaded
const releases = [
  ['Big.Buck.Bunny.2008.1080p.WEB.x264.AAC', 0.9, 812],
  ['Sintel.2010.1080p.WEB.x264.AAC', 1.2, 455],
  ['Tears.of.Steel.2012.2160p.WEB.H265.AAC', 6.3, 214],
  ['Elephants.Dream.2006.1080p.x264.AC3', 0.8, 167],
  ['Cosmos.Laundromat.2015.1080p.WEB.x264.AAC', 1.1, 98],
  ['Spring.2019.2160p.WEB.H265.EAC3', 2.4, 76],
  ['Night.of.the.Living.Dead.1968.1080p.WEB.x264.AAC', 7.9, 341],
  ['Charade.1963.720p.WEB.x264.AAC', 4.4, 129],
  ['His.Girl.Friday.1940.1080p.WEB.x264.FLAC', 9.1, 57],
  ['Plan.9.from.Outer.Space.1957.720p.x264.AAC', 3.2, 44],
].map(([title, size, seeders], i) => ({ title, size: Math.round(size * GB), seeders, ih: (i + 1).toString(16).padStart(40, 'a') }))

const cache = await fs.mkdtemp(path.join(os.tmpdir(), 'magplay-shots-'))

// A one-minute clip of Big Buck Bunny, cached as a torrent the server can play
const source = process.argv[2]
if (!source) throw new Error('Pass the path to Big Buck Bunny, e.g. big_buck_bunny_720p_h264.mov from https://download.blender.org/peach/bigbuckbunny_movies/')
const name = 'Big.Buck.Bunny.2008.720p.x264.AAC'
const media = path.join(cache, 'media', name)
await fs.mkdir(media, { recursive: true })
await exec('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', '60', '-t', '60', '-i', source,
  '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-g', '48',
  '-c:a', 'aac', '-ac', '2', '-movflags', '+faststart', path.join(media, `${name}.mp4`)], { timeout: 300_000 })
const torrent = await new Promise((resolve, reject) => createTorrent(media, { private: true, announceList: [], creationDate: 0 },
  (err, data) => err ? reject(err) : resolve(data)))
const parsed = await parseTorrent(torrent)
const torrentDir = path.join(cache, 'torrents', parsed.infoHash)
await fs.mkdir(torrentDir, { recursive: true })
await fs.writeFile(path.join(torrentDir, 'meta.torrent'), torrent)
await fs.cp(media, path.join(torrentDir, parsed.name), { recursive: true })
releases.push({ title: name, size: parsed.length, seeders: 1, ih: parsed.infoHash })

const feed = () => `<?xml version="1.0"?><rss version="2.0" xmlns:torznab="http://torznab.com/schemas/2015/feed"><channel><title>Free films</title>${releases.map(({ title, size, seeders, ih }) =>
  `<item><title>${title}</title><guid>${ih}</guid><link>magnet:?xt=urn:btih:${ih}</link><size>${size}</size><torznab:attr name="infohash" value="${ih}"/><torznab:attr name="seeders" value="${seeders}"/></item>`
).join('')}</channel></rss>`

const indexer = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/rss+xml' })
  res.end(feed())
}).listen(0, '127.0.0.1')
await once(indexer, 'listening')

const port = 38_000 + Math.floor(Math.random() * 1000)
const origin = `http://127.0.0.1:${port}`
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(TORZNAB_|JACKETT_|PROWLARR_|BITMAGNET_|EXTRA_TRACKERS)/.test(key)))
const server = spawn(process.execPath, ['apps/server/src/main.ts'], {
  cwd: root,
  stdio: 'inherit',
  env: { ...env, PORT: String(port), TORRENT_PORT: '0', CACHE_DIR: cache, TORZNAB_URL: `http://127.0.0.1:${indexer.address().port}/api`, TORZNAB_NAME: 'Free films', EXTRA_TRACKERS: '', DHT_ENABLED: 'false', LSD_ENABLED: 'false' },
})

const desktopView = { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, colorScheme: 'dark' }
const mobileView = { viewport: { width: 390, height: 800 }, deviceScaleFactor: 2, colorScheme: 'dark', isMobile: true, hasTouch: true }

try {
  for (let i = 0; !(await fetch(`${origin}/health`).then(r => r.ok, () => false)); i++) {
    if (i > 100) throw new Error('server did not start')
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  const browser = await chromium.launch()
  await fs.mkdir(out, { recursive: true })

  const shoot = async (options, prepare) => {
    const page = await browser.newPage(options)
    await prepare(page)
    const png = await page.screenshot()
    await page.close()
    return png.toString('base64')
  }
  // Both views side by side, bottom-aligned
  const compose = async (file, desktop, mobile) => {
    const page = await browser.newPage({ viewport: { width: 1790, height: 880 }, deviceScaleFactor: 2 })
    await page.setContent(`<body style="margin:0;padding:40px;display:flex;gap:40px;align-items:flex-end;background:#0b0d12">
      <img src="data:image/png;base64,${desktop}" style="width:1280px;border-radius:12px;box-shadow:0 10px 40px #0008">
      <img src="data:image/png;base64,${mobile}" style="width:390px;border-radius:28px;box-shadow:0 10px 40px #0008"></body>`)
    await page.screenshot({ path: path.join(out, file) })
    await page.close()
    console.log(`Saved docs/screenshots/${file}`)
  }

  const search = async page => {
    await page.goto(`${origin}/?q=${encodeURIComponent('free films')}`)
    await page.getByText('Big.Buck.Bunny', { exact: false }).first().waitFor()
  }
  await compose('search.png', await shoot(desktopView, search), await shoot(mobileView, search))

  const settings = async page => {
    await page.goto(`${origin}/settings`)
    await page.waitForSelector('#settings-body .settings-section')
    await page.waitForTimeout(500)
  }
  await compose('settings.png', await shoot(desktopView, settings), await shoot(mobileView, settings))

  const status = async page => {
    await page.goto(`${origin}/?q=${encodeURIComponent('free films')}`)
    await page.getByText('Big.Buck.Bunny', { exact: false }).first().waitFor()
    await page.locator('.status-button').click()
    await page.waitForSelector('.status-panel')
    await page.waitForTimeout(500)
  }
  await compose('status.png', await shoot(desktopView, status), await shoot(mobileView, status))

  const player = async page => {
    await page.goto(`${origin}/play/${parsed.infoHash}/0`)
    const video = page.locator('#video')
    await video.evaluate(v => { v.muted = true })
    await page.waitForFunction(() => document.querySelector('#video')?.currentTime > 0)
    await video.evaluate(async v => {
      v.currentTime = 22
      await new Promise(resolve => v.addEventListener('seeked', resolve, { once: true }))
      v.pause()
    })
    await video.hover({ force: true })
    await page.waitForTimeout(500)
  }
  await compose('player.png', await shoot(desktopView, player), await shoot(mobileView, player))
  await browser.close()
} finally {
  server.kill('SIGTERM')
  indexer.close()
  await fs.rm(cache, { recursive: true, force: true })
}
