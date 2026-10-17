import fs from 'node:fs/promises'
import path from 'node:path'
import { test, expect } from './fixtures.js'
import { capHlsPlaylist, chooseAudio, chooseSubtitles, direct, expectCues, expectPlaying, openPlayer, playResponse, producedSeconds, remux, seek } from './helpers.js'

test('cold concurrent torrent/probe requests share one initialization', async ({ page, app }) => {
  const responses = await Promise.all(Array.from({ length: 8 }, (_, i) =>
    page.request.get(i % 2 ? `${app.origin}/api/probe/${app.ih}/${app.files[direct]}` : `${app.origin}/api/torrents/${app.ih}`)))
  for (const response of responses) expect(response.ok(), await response.text()).toBeTruthy()
  expect(app.logs()).not.toContain('Cannot add duplicate torrent')
})

test('search → torrent → direct MP4: real decoded frames and Range seeking', async ({ page, app }) => {
  await page.goto(`${app.origin}/?q=Playback`)
  await page.getByRole('link', { name: 'Playback fixtures', exact: true }).click()
  await expect(page).toHaveURL(app.torrent)
  const response = playResponse(page)
  await page.locator(`a.label[href="/play/${app.ih}/${app.files[direct]}"]`).click()
  const decision = await (await response).json()
  expect(decision.mode).toBe('direct')
  expect(decision.session).toBeUndefined()
  await expectPlaying(page)
  const range = await page.request.get(`${app.origin}/raw/${app.ih}/${app.files[direct]}`, { headers: { Range: 'bytes=0-1023' } })
  expect(range.status()).toBe(206)
  expect((await range.body()).length).toBe(1024)
  await page.locator('#video').evaluate(v => { v.currentTime = 45 })
  await expect.poll(() => page.locator('#video').evaluate(v => v.currentTime)).toBeGreaterThanOrEqual(45)
  await expectPlaying(page)
})

test('MKV/AC3 remux: seek, switch audio, restart before session offset', async ({ page, app }) => {
  expect((await openPlayer(page, app, remux)).mode).toBe('remux')
  await seek(page, 35)
  await expect.poll(() => page.locator('#seek').inputValue().then(Number)).toBeGreaterThanOrEqual(35)
  const switching = playResponse(page)
  await chooseAudio(page, 1)
  const switched = await (await switching).json()
  expect(switched.mode).toBe('remux')
  expect(switched.offset).toBeGreaterThanOrEqual(35)
  await expectPlaying(page)
  const restarting = playResponse(page)
  await seek(page, 10)
  const restarted = await (await restarting).json()
  expect(restarted.session).not.toBe(switched.session)
  expect(restarted.offset).toBe(10)
  await expectPlaying(page)
})

test('seeking past the loaded HLS playlist restarts the session at the exact target', async ({ page, app }) => {
  await capHlsPlaylist(page) // the browser never sees past the first ~18 s of the session
  await openPlayer(page, app, remux)
  // ffmpeg is not capped: once it has produced well past the seek target, a
  // decision based on server-side progress would wrongly seek in-session and
  // the browser would silently clamp to the capped playlist's end instead
  await expect.poll(() => producedSeconds(app), { timeout: 30_000 }).toBeGreaterThan(32)
  const restarting = playResponse(page)
  await seek(page, 30)
  const decision = await (await restarting).json()
  expect(decision.offset).toBe(30)
  await expectPlaying(page)
  await expect.poll(() => page.locator('#seek').inputValue().then(Number)).toBeGreaterThanOrEqual(30)
})

test('rapid audio changes preserve position and leave only the latest session', async ({ page, app }) => {
  await openPlayer(page, app, remux)
  await seek(page, 30)
  await expect.poll(() => page.locator('#seek').inputValue().then(Number)).toBeGreaterThanOrEqual(30)
  let release
  let held
  const blocked = new Promise(resolve => { held = resolve })
  const gate = new Promise(resolve => { release = resolve })
  let count = 0
  const requests = []
  await page.route('**/api/play', async route => {
    requests.push(route.request().postDataJSON())
    const response = await route.fetch()
    if (++count === 1) { held(); await gate }
    await route.fulfill({ response })
  })
  try {
    await chooseAudio(page, 1)
    await blocked
    await chooseAudio(page, 0)
    await chooseAudio(page, 1)
    release()
    await expect.poll(() => requests.length).toBe(2)
    expect(requests.at(-1).audio).toBe(1)
    expect(requests.at(-1).start).toBeGreaterThanOrEqual(30)
    await expectPlaying(page)
    await expect.poll(async () => (await fs.readdir(path.join(app.cache, 'hls'))).length).toBe(1)
  } finally { release() }
})

test('embedded and external subtitles follow a restarted HLS offset', async ({ page, app }) => {
  await openPlayer(page, app, remux)
  await chooseSubtitles(page, 'embedded:0')
  await expectCues(page, 'First subtitle')
  await seek(page, 30)
  await expect.poll(() => page.locator('#seek').inputValue().then(Number)).toBeGreaterThanOrEqual(30)
  const switching = playResponse(page)
  await chooseAudio(page, 1)
  const decision = await (await switching).json()
  await expectPlaying(page)
  await expectCues(page, 'Middle subtitle')
  await expectCues(page, 'Last subtitle')
  const embeddedStart = await page.locator('#video').evaluate(v => [...v.textTracks[0].cues].find(c => c.text === 'Last subtitle').startTime)
  expect(Math.abs(embeddedStart - (70 - decision.offset))).toBeLessThan(2)
  const external = `file:${app.files['Playback.S01E02.srt']}`
  await chooseSubtitles(page, external)
  await expectCues(page, 'Last subtitle')
  const lastStart = await page.locator('#video').evaluate(v => [...v.textTracks[0].cues].find(c => c.text === 'Last subtitle').startTime)
  expect(lastStart).toBeCloseTo(70 - decision.offset, 0)
  // A → Off → A must not create duplicate polling loops/cues.
  await chooseSubtitles(page, '')
  await chooseSubtitles(page, external)
  await expectCues(page, 'Last subtitle')
  expect(await page.locator('#video').evaluate(v => [...v.textTracks[0].cues].filter(c => c.text === 'Last subtitle').length)).toBe(1)
})

test('direct playback can load external subtitles without an HLS session', async ({ page, app }) => {
  expect((await openPlayer(page, app, direct)).mode).toBe('direct')
  await chooseSubtitles(page, `file:${app.files['Playback.S01E02.srt']}`)
  await expectCues(page, 'Last subtitle')
  const lastStart = await page.locator('#video').evaluate(v => [...v.textTracks[0].cues].find(c => c.text === 'Last subtitle').startTime)
  expect(lastStart).toBe(70)
  expect(await fs.readdir(path.join(app.cache, 'hls'))).toEqual([])
})

test('failed playback request offers retry and recovers', async ({ page, app }) => {
  await page.route('**/api/play', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Fixture startup failure' }) }), { times: 1 })
  await page.goto(app.player(direct))
  await expect(page.locator('#overlay')).toContainText('Fixture startup failure')
  await page.getByRole('button', { name: 'Try again', exact: true }).click()
  await expectPlaying(page)
})

test('a malformed successful playback response is visible and retryable', async ({ page, app }) => {
  await page.route('**/api/play', route => route.fulfill({ status: 200, contentType: 'text/html', body: '<html>Proxy error page</html>' }), { times: 1 })
  await page.goto(app.player(direct))
  await expect(page.locator('#overlay')).toContainText('Invalid JSON response')
  await page.getByRole('button', { name: 'Try again', exact: true }).click()
  await expectPlaying(page)
})

test('Back cleans the HLS session; Forward plays again', async ({ page, app }) => {
  await page.goto(app.torrent)
  const response = playResponse(page)
  await page.locator(`a.label[href="/play/${app.ih}/${app.files[remux]}"]`).click()
  const decision = await (await response).json()
  await expectPlaying(page)
  await page.goBack()
  await expect(page).toHaveURL(app.torrent)
  await expect.poll(() => fs.stat(path.join(app.cache, 'hls', decision.session)).then(() => true, () => false)).toBe(false)
  await page.goForward()
  await expect(page).toHaveURL(app.player(remux))
  await page.waitForFunction(() => document.querySelector('#video').getAttribute('src') ||
    [...document.querySelectorAll('#overlay button')].some(button => button.textContent === 'Resume'))
  const resume = page.getByRole('button', { name: 'Resume', exact: true })
  if (await resume.isVisible()) await resume.click()
  await expectPlaying(page)
})

test('next-episode countdown can be cancelled and does not navigate later', async ({ page, app }) => {
  await openPlayer(page, app, direct)
  await page.clock.install()
  await page.locator('#video').evaluate(v => { v.currentTime = v.duration - 0.2 })
  await expect(page.locator('#overlay')).toContainText('Next: S01E02')
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(page.locator('#overlay')).toBeEmpty()
  // Media playback above used real time; advance only the UI timer now.
  await page.clock.runFor(11_000)
  await expect(page).toHaveURL(app.player(direct))
})

test('leaving during probing cannot start stale playback; restored activation works', async ({ page, app }) => {
  let release, observed, finished
  const gate = new Promise(resolve => { release = resolve })
  const held = new Promise(resolve => { observed = resolve })
  const done = new Promise(resolve => { finished = resolve })
  let posts = 0
  page.on('request', request => { if (request.url().endsWith('/api/play')) posts++ })
  await page.route('**/api/probe/**', async route => {
    const response = await route.fetch()
    observed()
    await gate
    await route.fulfill({ response }).catch(() => {}) // original fetch may have been aborted
    finished()
  })
  try {
    await page.goto(app.player(remux))
    await held
    await page.evaluate(() => dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })))
    release()
    await done
    expect(posts).toBe(0)
    await page.evaluate(() => dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })))
    await expectPlaying(page)
  } finally { release() }
})

test('leaving with an unknown playback response closes its server-side session', async ({ page, app }) => {
  let release, observed, session
  const gate = new Promise(resolve => { release = resolve })
  const held = new Promise(resolve => { observed = resolve })
  let first = true
  await page.route('**/api/play', async route => {
    const response = await route.fetch()
    if (first) {
      first = false
      session = (await response.json()).session
      observed()
      await gate
    }
    await route.fulfill({ response }).catch(() => {})
  })
  try {
    await page.goto(app.player(remux))
    await held
    expect(session).toBeTruthy()
    await page.evaluate(() => dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })))
    await expect.poll(() => fs.stat(path.join(app.cache, 'hls', session)).then(() => true, () => false)).toBe(false)
    release()
    await page.evaluate(() => dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })))
    await expectPlaying(page)
  } finally { release() }
})

test('pagehide clears next-episode countdown and status polling', async ({ page, app }) => {
  await openPlayer(page, app, direct)
  let polls = 0
  page.on('request', request => { if (request.url().includes('/status?')) polls++ })
  await page.clock.install()
  await page.locator('#video').evaluate(v => { v.currentTime = v.duration - 0.2 })
  await expect(page.locator('#overlay')).toContainText('Next: S01E02')
  await page.evaluate(() => dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })))
  const before = polls
  await page.clock.runFor(11_000)
  expect(polls).toBe(before)
  await expect(page).toHaveURL(app.player(direct))
})

test('direct playback persists per-file progress and offers resume or start over', async ({ page, app }) => {
  await openPlayer(page, app, direct)
  await page.locator('#video').evaluate(v => { v.currentTime = 30 })
  const key = `magplay:progress:${app.ih}:${app.files[direct]}`
  await expect.poll(() => page.evaluate(key => JSON.parse(localStorage.getItem(key))?.position || 0, key)).toBeGreaterThanOrEqual(30)
  await page.locator('#video').evaluate(v => v.pause())
  await page.reload()
  await expect(page.getByRole('button', { name: 'Resume', exact: true })).toBeVisible()
  const response = playResponse(page)
  await page.getByRole('button', { name: 'Resume', exact: true }).click()
  const resumed = await response
  expect(resumed.request().postDataJSON().start).toBeGreaterThanOrEqual(30)
  await expectPlaying(page)
  expect(await page.locator('#video').evaluate(v => v.currentTime)).toBeGreaterThanOrEqual(30)
  await page.goto(app.torrent)
  await expect(page.locator('a.button.primary')).toContainText('Resume')
  await page.goto(app.player(direct))
  await expect(page.getByRole('button', { name: 'Start over', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Start over', exact: true }).click()
  await expectPlaying(page)
  expect(await page.locator('#video').evaluate(v => v.currentTime)).toBeLessThan(5)
})

test('HLS resume uses absolute file position after audio/seek session offsets', async ({ page, app }) => {
  await openPlayer(page, app, remux)
  await seek(page, 30)
  await expect.poll(() => page.locator('#seek').inputValue().then(Number)).toBeGreaterThanOrEqual(30)
  const switching = playResponse(page)
  await chooseAudio(page, 1)
  await switching
  await expectPlaying(page)
  await page.locator('#video').evaluate(v => v.pause())
  await page.reload()
  await expect(page.getByRole('button', { name: 'Resume', exact: true })).toBeVisible()
  const response = playResponse(page)
  await page.getByRole('button', { name: 'Resume', exact: true }).click()
  const decision = await (await response).json()
  expect(decision.offset).toBeGreaterThanOrEqual(30)
  await expectPlaying(page)
})

test('completed media restarts instead of offering to resume at the credits', async ({ page, app }) => {
  await openPlayer(page, app, direct)
  await page.locator('#video').evaluate(v => { v.currentTime = v.duration - 0.2 })
  await expect(page.locator('#overlay')).toContainText('Next: S01E02')
  await page.reload()
  await expectPlaying(page)
  await expect(page.getByRole('button', { name: 'Resume', exact: true })).toHaveCount(0)
  expect(await page.locator('#video').evaluate(v => v.currentTime)).toBeLessThan(5)
})

test('blocked browser storage cannot break playback or seeking', async ({ page, app }) => {
  await page.addInitScript(() => {
    for (const method of ['getItem', 'setItem']) {
      Object.defineProperty(Storage.prototype, method, {
        value () { throw new DOMException('Storage blocked', 'SecurityError') },
      })
    }
  })
  await openPlayer(page, app, direct)
  await page.locator('#video').evaluate(v => { v.currentTime = 30 })
  await expectPlaying(page)
})

test('HLS overload is retryable and does not disturb admitted players', async ({ page, app }) => {
  const play = tab => page.request.post(`${app.origin}/api/play`, {
    data: {
      ih: app.ih, idx: app.files[remux], caps: { h264: true, aac: true }, tab,
    }
  })
  const first = await play('limit-one')
  const second = await play('limit-two')
  expect(first.status()).toBe(200)
  expect(second.status()).toBe(200)
  const rejected = await play('limit-three')
  expect(rejected.status()).toBe(503)
  expect(rejected.headers()['retry-after']).toBe('5')
  expect(rejected.headers()['cache-control']).toBe('no-store')
  const prior = await second.json()
  const status = await page.request.get(`${app.origin}/api/torrents/${app.ih}/status?session=${prior.session}`)
  expect((await status.json()).session.failed).toBe(false)
  expect((await play('limit-one')).status()).toBe(200)
})

test('HTTP media cache policies preserve ranges, validators and session freshness', async ({ page, app }) => {
  for (const url of [`/raw/${app.ih}/${app.files[direct]}?download=1`, `/tar/${app.ih}`]) {
    const head = await page.request.head(app.origin + url, { headers: { Range: 'bytes=0-9' } })
    expect(head.status()).toBe(200)
    expect(head.headers()['cache-control']).toBe('private, max-age=3600, must-revalidate')
    expect(head.headers()['content-disposition']).toContain('attachment')
    const etag = head.headers().etag
    const cached = await page.request.get(app.origin + url, { headers: { 'If-None-Match': `"other", W/${etag}`, Range: 'bytes=0-9' } })
    expect(cached.status()).toBe(304)
    expect((await cached.body()).length).toBe(0)
    const part = await page.request.get(app.origin + url, { headers: { Range: 'bytes=0-9', 'If-Range': etag } })
    expect(part.status()).toBe(206)
    expect((await part.body()).length).toBe(10)
    const stale = await page.request.get(app.origin + url, { headers: { Range: 'bytes=0-9', 'If-Range': `W/${etag}` } })
    expect(stale.status()).toBe(200)
    expect((await stale.body()).length).toBe(Number(head.headers()['content-length']))
    const invalid = await page.request.get(app.origin + url, { headers: { Range: 'bytes=999999999999-' } })
    expect(invalid.status()).toBe(416)
    expect(invalid.headers()['cache-control']).toBe('no-store')
  }
  const probeUrl = `${app.origin}/api/probe/${app.ih}/${app.files[remux]}`
  const probe = await page.request.get(probeUrl)
  expect(probe.headers()['cache-control']).toBe('private, no-cache')
  expect((await page.request.head(probeUrl, { headers: { 'If-None-Match': probe.headers().etag } })).status()).toBe(304)
  const decision = await openPlayer(page, app, remux)
  const playlist = await page.request.get(app.origin + decision.url, { headers: { 'If-None-Match': '*' } })
  expect(playlist.status()).toBe(200)
  expect(playlist.headers()['cache-control']).toBe('no-store')
  const text = await playlist.text()
  const segment = text.split('\n').find(line => line.endsWith('.m4s'))
  expect(segment).toBeTruthy()
  const segmentUrl = `${app.origin}/hls/${decision.session}/${segment}`
  const media = await page.request.get(segmentUrl)
  expect(media.headers()['cache-control']).toBe('private, no-cache')
  expect((await page.request.head(segmentUrl, { headers: { 'If-None-Match': media.headers().etag } })).status()).toBe(304)
  const sub = await page.request.get(`${app.origin}/hls/${decision.session}/sub_0.vtt`, { headers: { 'If-None-Match': '*' } })
  expect(sub.status()).toBe(200)
  expect(sub.headers()['cache-control']).toBe('no-store')
  const completedSub = `${app.origin}/subs/${app.ih}/${app.files['Playback.S01E02.srt']}/file.vtt`
  const subtitles = await page.request.get(completedSub)
  expect(subtitles.headers()['cache-control']).toBe('private, no-cache')
  expect((await page.request.get(completedSub, { headers: { 'If-None-Match': subtitles.headers().etag } })).status()).toBe(304)
  await page.request.delete(`${app.origin}/api/play/${decision.session}`)
  const removed = await page.request.get(segmentUrl, { headers: { 'If-None-Match': media.headers().etag } })
  expect(removed.status()).toBe(404)
  expect(removed.headers()['cache-control']).toBe('no-store')
})
