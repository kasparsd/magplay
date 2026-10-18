// Capture the Player at laptop and phone sizes, in dark and light, with a 2.39:1 and a 16:9 file.
// Media is generated with ffmpeg (testsrc2), so nothing is downloaded. The 2.39:1 file has its last
// 40% zeroed in the cache, so hash checking leaves it "not downloaded" and the seek bar shows gaps.
// Usage: npm run build && node tools/scripts/player-screenshots.mjs [output dir]
import { chromium } from '@playwright/test'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs/promises'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import createTorrent from 'create-torrent'
import parseTorrent from 'parse-torrent'

const exec = promisify(execFile)
const root = path.resolve(import.meta.dirname, '../..')
const out = path.resolve(process.argv[2] ?? path.join(root, 'docs/checkpoints/2026-10-17-player-redesign'))
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
await fs.mkdir(out, { recursive: true })

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'magplay-player-shots-'))
const name = 'Open.Movie.Shorts.S01.1080p.WEB.x264'
const media = path.join(dir, 'media', name)
await fs.mkdir(media, { recursive: true })
const ff = args => exec('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { timeout: 300_000 })
const srt = path.join(media, 'subs.srt')
await fs.writeFile(srt, Array.from({ length: 30 }, (_, i) => `${i + 1}\n00:${String(Math.floor(i * 6 / 60)).padStart(2, '0')}:${String(i * 6 % 60).padStart(2, '0')},500 --> 00:${String(Math.floor((i * 6 + 4) / 60)).padStart(2, '0')}:${String((i * 6 + 4) % 60).padStart(2, '0')},000\nA subtitle line, number ${i + 1}\n`).join('\n'))
// S01E01: 16:9 MKV with AC3 + AAC audio and English subtitles: remux
const tmp169 = path.join(dir, 'e01.mp4')
await ff(['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=48000',
  '-t', '180', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '30', '-pix_fmt', 'yuv420p', '-g', '48', '-c:a', 'aac', tmp169])
await ff(['-i', tmp169, '-i', srt, '-map', '0:v', '-map', '0:a', '-map', '0:a', '-map', '1:s', '-c:v', 'copy', '-c:a:0', 'ac3', '-c:a:1', 'aac', '-c:s', 'srt',
  '-metadata:s:a:0', 'language=eng', '-metadata:s:a:1', 'language=fra', '-metadata:s:s:0', 'language=eng',
  path.join(media, 'Open.Movie.Shorts.S01E01.1080p.WEB.x264.mkv')])
// S01E02: 2.39:1 MP4 that plays directly
await ff(['-f', 'lavfi', '-i', 'testsrc2=size=1280x536:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
  '-t', '180', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '30', '-pix_fmt', 'yuv420p', '-g', '48', '-c:a', 'aac', '-movflags', '+faststart',
  path.join(media, 'Open.Movie.Shorts.S01E02.1080p.WEB.x264.mp4')])
await fs.copyFile(path.join(media, 'Open.Movie.Shorts.S01E02.1080p.WEB.x264.mp4'), path.join(media, 'Open.Movie.Shorts.S01E03.1080p.WEB.x264.mp4'))
await fs.rm(srt)
await fs.rm(tmp169)

const torrent = await new Promise((resolve, reject) => createTorrent(media, { private: true, announceList: [], creationDate: 0 },
  (err, data) => err ? reject(err) : resolve(data)))
const parsed = await parseTorrent(torrent)
const cache = path.join(dir, 'cache')
const torrentDir = path.join(cache, 'torrents', parsed.infoHash)
await fs.mkdir(torrentDir, { recursive: true })
await fs.writeFile(path.join(torrentDir, 'meta.torrent'), torrent)
await fs.cp(media, path.join(torrentDir, parsed.name), { recursive: true })
const files = Object.fromEntries(parsed.files.map((f, idx) => [path.basename(f.path), idx]))
// Zero the last 40% of the 2.39:1 file, so its pieces fail the hash check and count as not downloaded
const partial = path.join(torrentDir, parsed.name, 'Open.Movie.Shorts.S01E02.1080p.WEB.x264.mp4')
const { size } = await fs.stat(partial)
const handle = await fs.open(partial, 'r+')
await handle.write(Buffer.alloc(Math.floor(size * 0.4)), 0, Math.floor(size * 0.4), Math.floor(size * 0.6))
await handle.close()

const indexer = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/rss+xml' })
  res.end('<?xml version="1.0"?><rss version="2.0"><channel><title>none</title></channel></rss>')
})
indexer.listen(0, '127.0.0.1')
await once(indexer, 'listening')
const port = await new Promise(resolve => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => resolve(p)) }) })
const origin = `http://127.0.0.1:${port}`
const server = spawn(process.execPath, ['apps/server/src/server.js'], {
  cwd: root,
  env: { ...process.env, PORT: String(port), TORRENT_PORT: '0', CACHE_DIR: cache, TORZNAB_URL: `http://127.0.0.1:${indexer.address().port}/feed`, EXTRA_TRACKERS: '', DHT_ENABLED: 'false', LSD_ENABLED: 'false' },
  stdio: ['ignore', 'inherit', 'inherit'],
})
for (let i = 0; !(await fetch(`${origin}/health`).then(r => r.ok, () => false)); i++) {
  if (i > 100) throw new Error('server did not start')
  await sleep(100)
}

const player = file => `${origin}/play/${parsed.infoHash}/${files[file]}`
const wide = 'Open.Movie.Shorts.S01E02.1080p.WEB.x264.mp4' // 2.39:1, direct
const tv = 'Open.Movie.Shorts.S01E01.1080p.WEB.x264.mkv' // 16:9, remux
const browser = await chromium.launch()
const shots = []

async function open (scheme, viewport, file) {
  const context = await browser.newContext({ viewport, colorScheme: scheme, deviceScaleFactor: 1, hasTouch: viewport.width < 600 })
  const page = await context.newPage()
  await page.goto(player(file))
  await page.waitForFunction(() => { const v = document.querySelector('#video'); return v.readyState >= 2 && !v.paused })
  await sleep(2500)
  return { page, context }
}
// Leave the page first so it closes its HLS session; a closed context sends no beacons
async function close (page, context) {
  await page.goto('about:blank')
  await sleep(300)
  await context.close()
}
const shot = async (page, file, note) => {
  await page.screenshot({ path: path.join(out, file) })
  shots.push([file, note])
}

for (const scheme of ['dark', 'light']) {
  for (const [w, h] of [[1440, 900], [1280, 800], [800, 600], [375, 812], [812, 375]]) {
    for (const [file, ar] of [[wide, '239'], [tv, '169']]) {
      const { page, context } = await open(scheme, { width: w, height: h }, file)
      const box = await page.locator('#stage').boundingBox()
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 3)
      await sleep(300)
      await shot(page, `${scheme}-${w}x${h}-${ar}-chrome.png`, `${w}×${h}, ${ar === '239' ? '2.39:1 direct' : '16:9 remux'}, chrome showing`)
      if (scheme === 'dark' && w === 1440) {
        await page.mouse.move(5, h - 5)
        await sleep(3200)
        await shot(page, `${scheme}-${w}x${h}-${ar}-hidden.png`, `${w}×${h}, ${ar === '239' ? '2.39:1' : '16:9'}, chrome faded while playing`)
      }
      await close(page, context)
    }
  }
}

// Menus, tooltip, key sheet and Performance
for (const scheme of ['dark', 'light']) {
  for (const [w, h] of [[1280, 800], [375, 812]]) {
    const { page, context } = await open(scheme, { width: w, height: h }, tv)
    await page.locator('#video').evaluate(v => v.pause())
    for (const slot of ['subs-slot', 'audio-slot', 'speed-slot', 'more-slot']) {
      if (!(await page.locator(`#${slot} summary`).isVisible())) continue
      await page.locator(`#${slot} summary`).click()
      await sleep(200)
      await shot(page, `${scheme}-${w}x${h}-menu-${slot.replace('-slot', '')}.png`, `${w}×${h}, ${slot.replace('-slot', '')} menu open`)
      await page.keyboard.press('Escape')
    }
    await page.keyboard.press('?')
    await sleep(200)
    await shot(page, `${scheme}-${w}x${h}-keys.png`, `${w}×${h}, ? key sheet`)
    await page.keyboard.press('Escape')
    await close(page, context)
  }
  // Seek tooltip on the partly downloaded 2.39:1 file, and the restart prediction on the remux
  for (const [file, fraction, label] of [[wide, 0.8, 'missing'], [tv, 0.75, 'restart']]) {
    const { page, context } = await open(scheme, { width: 1280, height: 800 }, file)
    await sleep(2500) // a status poll for the server ranges
    const track = await page.locator('#seekbar .track').boundingBox()
    await page.mouse.move(track.x + 10, track.y - 30)
    await page.mouse.move(track.x + track.width * fraction, track.y + 2)
    await sleep(300)
    await shot(page, `${scheme}-1280x800-tooltip-${label}.png`, `1280×800, seek tooltip: ${label === 'missing' ? 'not downloaded yet' : 'past the converted range'}`)
    await close(page, context)
  }
  // Performance after 30 s of polls, scrolled into view
  for (const [file, label] of [[tv, 'remux'], [wide, 'direct']]) {
    const { page, context } = await open(scheme, { width: 1280, height: 800 }, file)
    await page.getByRole('button', { name: 'Performance' }).click()
    await sleep(30_000)
    await page.locator('#performance').scrollIntoViewIfNeeded()
    await shot(page, `${scheme}-1280x800-performance-${label}.png`, `1280×800, Performance disclosure, ${label}`)
    if (scheme === 'dark') {
      await page.setViewportSize({ width: 375, height: 812 })
      await sleep(500)
      await page.locator('#performance').scrollIntoViewIfNeeded()
      await shot(page, `${scheme}-375x812-performance-${label}.png`, `375×812, Performance disclosure, ${label}`)
    }
    await close(page, context)
  }
}

// Fullscreen with the title overlay and a menu
{
  const { page, context } = await open('dark', { width: 1280, height: 800 }, tv)
  await page.mouse.move(640, 300)
  await page.getByRole('button', { name: 'Fullscreen', exact: true }).click()
  await sleep(500)
  await page.mouse.move(640, 320)
  await page.locator('#subs-slot summary').click()
  await sleep(200)
  await shot(page, 'dark-1280x800-fullscreen-subtitles.png', '1280×800 fullscreen: title overlay and Subtitles menu')
  await close(page, context)
}

await fs.writeFile(path.join(out, 'shots.json'), JSON.stringify(shots, null, 2))
await browser.close()
server.kill('SIGTERM')
await once(server, 'exit')
indexer.close()
await fs.rm(dir, { recursive: true, force: true })
console.log(`${shots.length} screenshots in ${out}`)
