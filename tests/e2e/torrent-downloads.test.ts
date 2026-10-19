import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import createTorrent from 'create-torrent'
import parseTorrent from 'parse-torrent'
import type { TorrentInfo } from '@magplay/api-contract'
import { test, expect } from './fixtures.js'

/** Original non-media bytes in a real production-format cache; no mocked torrent/download responses. */
async function cacheDownload (cache: string, files: Record<string, string>): Promise<{ ih: string, contents: Buffer }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'magplay-download-'))
  try {
    const entries = Object.entries(files)
    for (const [name, content] of entries) await fs.writeFile(path.join(dir, name), content)
    const single = entries.length === 1 ? entries[0] : undefined
    const name = single?.[0] ?? 'Download fixtures'
    const input = single ? path.join(dir, single[0]) : dir
    const torrent = await new Promise<Uint8Array>((resolve, reject) => createTorrent(input, {
      name, private: true, announceList: [], creationDate: 0,
    }, (err, data) => { if (err) reject(err); else resolve(data) }))
    const parsed = await parseTorrent(torrent)
    const target = path.join(cache, 'torrents', parsed.infoHash)
    await fs.mkdir(target, { recursive: true })
    await fs.writeFile(path.join(target, 'meta.torrent'), torrent)
    if (single) await fs.copyFile(input, path.join(target, name))
    else await fs.cp(dir, path.join(target, name), { recursive: true })
    return { ih: parsed.infoHash, contents: Buffer.from(single?.[1] ?? '') }
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

test('a single non-video file has a primary download that returns its original bytes', { tag: '@slow' }, async ({ page, app }, testInfo) => {
  const { origin, cache } = app
  const fixture = await cacheDownload(cache, { 'linux-image.iso': 'Original test disk image bytes — not a bootable image.\n' })
  await page.goto(`${origin}/t/${fixture.ih}`)
  const torrent = page.locator('#torrent')
  await expect(torrent).toContainText('No videos in this torrent. Download the files')
  await expect(torrent.locator('a[href^="/play/"]')).toHaveCount(0)
  const primary = torrent.locator('.actions a.primary')
  await expect(primary).toHaveText('Download file')
  await expect(primary).toHaveAttribute('href', `/raw/${fixture.ih}/0/linux-image.iso?download=1`)
  await expect(torrent.getByRole('link', { name: 'linux-image.iso', exact: true })).toHaveAttribute('href', `/raw/${fixture.ih}/0/linux-image.iso?download=1`)
  await page.screenshot({ path: testInfo.outputPath('download-page.png'), fullPage: true })
  const pending = page.waitForEvent('download')
  await primary.click()
  const download = await pending
  expect(download.suggestedFilename()).toBe('linux-image.iso')
  const downloaded = await download.path()
  if (!downloaded) throw new Error('Expected the completed download on disk')
  expect(await fs.readFile(downloaded)).toEqual(fixture.contents)
  await torrent.getByRole('button', { name: 'More ▾' }).click()
  await expect(torrent.getByRole('link', { name: 'Open in your torrent client' })).toHaveAttribute('href', /^magnet:/)
})

test('a download-only pack has a primary tar download, individual downloads and usable phone layout', { tag: '@slow' }, async ({ page, app }, testInfo) => {
  const { origin, cache } = app
  const files = { 'release-notes.txt': 'Original release notes for the download fixture.\n', 'audio-recording.flac': 'Original audio fixture bytes.\n' }
  const { ih } = await cacheDownload(cache, files)
  await page.setViewportSize({ width: 375, height: 812 })
  await page.goto(`${origin}/t/${ih}`)
  const torrent = page.locator('#torrent')
  const primary = torrent.locator('.actions a.primary')
  await expect(primary).toHaveText(/^Download all \(.tar,/)
  await expect(primary).toHaveAttribute('href', `/tar/${ih}/Download%20fixtures.tar`)
  await expect(torrent.locator('li.file')).toHaveCount(2)
  await expect(torrent.locator('li.file').getByRole('link', { name: 'Download', exact: true })).toHaveCount(2)
  await expect(torrent).not.toContainText(/No media file found|null|undefined|0 MB/)
  await expect(torrent.locator('.meta')).toContainText(' B')
  await expect(torrent.locator('a[href^="/play/"]')).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath('download-page.png'), fullPage: true })
  const pending = page.waitForEvent('download')
  await primary.click()
  const download = await pending
  expect(download.suggestedFilename()).toBe('Download fixtures.tar')
  const downloaded = await download.path()
  if (!downloaded) throw new Error('Expected the completed tar download on disk')
  const archive = await fs.readFile(downloaded)
  for (const [name, content] of Object.entries(files)) {
    expect(archive.includes(Buffer.from(name))).toBe(true)
    expect(archive.includes(Buffer.from(content))).toBe(true)
    const link = torrent.getByRole('link', { name, exact: true })
    const url = await link.getAttribute('href')
    if (!url) throw new Error(`Expected a download URL for ${name}`)
    const response = await page.request.get(`${origin}${url}`)
    expect(response.status()).toBe(200)
    expect(await response.body()).toEqual(Buffer.from(content))
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

test('mixed torrents keep resume and video menus while offering downloads for other files', { tag: '@slow' }, async ({ page, app }) => {
  const { origin } = app
  // The existing browser fixture has real videos and an external subtitle.
  const info = await (await page.request.get(app.torrent.replace('/t/', '/api/torrents/'))).json() as TorrentInfo
  const video = info.files.find(f => f.isVideo)
  if (!video) throw new Error('Expected a video in the mixed fixture')
  await page.goto(origin)
  await page.evaluate(({ ih, idx }) => {
    localStorage.setItem(`magplay:last:${ih}`, JSON.stringify({ idx, at: Date.now() }))
    localStorage.setItem(`magplay:progress:${ih}:${idx}`, JSON.stringify({ position: 25, duration: 90, completed: false, at: Date.now() }))
  }, { ih: info.infoHash, idx: video.idx })
  await page.goto(app.torrent)
  const torrent = page.locator('#torrent')
  await expect(torrent.locator('.actions a.primary')).toHaveText(/Resume.*at 0:25/)
  await expect(torrent.locator('.actions a.primary')).toHaveAttribute('href', `/play/${info.infoHash}/${video.idx}`)
  await torrent.getByRole('button', { name: 'More ▾' }).click()
  await expect(torrent.getByRole('link', { name: /^Download all/ })).toBeVisible()
  await torrent.locator('details.others summary').click()
  await expect(torrent.locator('li.plain').getByRole('link', { name: 'Download', exact: true })).toBeVisible()
  await expect(torrent).not.toContainText('No videos in this torrent')
})

test('the adult setting explicitly describes Explore-only coverage', { tag: '@slow' }, async ({ page, app }) => {
  const { origin } = app
  await page.goto(`${origin}/settings#sources`)
  await expect(page.getByLabel('Show adult content in Explore', { exact: true })).toBeVisible()
  await expect(page.locator('#sources')).toContainText('This does not filter search results from your sources.')
})
