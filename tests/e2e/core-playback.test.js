// The server without ffmpeg (the magplay-core image): files stream directly or are repackaged in the browser.
// The fixtures are still generated with ffmpeg on the test machine; only the server under test lacks it.
import { test, expect } from './fixtures.js'
import { chooseAudio, chooseSubtitles, countPlays, direct, expectCues, expectPlaying, openPlayer, playResponse, remux, seek } from './helpers.js'

test.use({ serverEnv: { FFMPEG_PATH: '/nonexistent/ffmpeg' } })

test('a missing ffmpeg is a warning, not a failed start', async ({ page, app }) => {
  const status = await (await page.request.get(`${app.origin}/api/status`)).json()
  const ffmpeg = status.checks.find(c => c.id === 'ffmpeg')
  expect(ffmpeg.level).toBe('warn')
  expect(ffmpeg.value).toBe('Not installed')
  expect(status.checks.filter(c => c.level === 'error')).toEqual([])
  const debug = await (await page.request.get(`${app.origin}/api/debug`)).json()
  expect(debug.ffmpeg).toBeNull()
  expect(debug.serverConversion).toBe(false)
  expect(app.logs()).toContain('ffmpeg.checked')
})

test('a faststart MP4 still plays directly', async ({ page, app }) => {
  const decision = await openPlayer(page, app, direct)
  expect(decision.mode).toBe('direct')
  expect(decision.session).toBeUndefined()
})

test('MKV/AC3 is repackaged in the browser: whole-file timeline, seeking, audio switch, .srt subtitles', async ({ page, app }) => {
  const decision = await openPlayer(page, app, remux)
  expect(decision).toMatchObject({ mode: 'browser-remux', audio: 0, url: `/raw/${app.ih}/${app.files[remux]}` })
  expect(decision.session).toBeUndefined()
  expect(await page.locator('#video').evaluate(v => v.duration)).toBeGreaterThan(89)
  await seek(page, 35)
  await expect.poll(() => page.locator('#video').evaluate(v => v.currentTime)).toBeGreaterThanOrEqual(35)
  await expectPlaying(page)
  const switching = playResponse(page)
  await chooseAudio(page, 1)
  const switched = await (await switching).json()
  expect(switched).toMatchObject({ mode: 'browser-remux', audio: 1 })
  await expectPlaying(page)
  // The position survives the audio switch: the browser restarts its own conversion at the same place
  expect(await page.locator('#video').evaluate(v => v.currentTime)).toBeGreaterThan(34)
  // The external SubRip file is converted in Node; cue times are media times because the timeline is the whole file
  await chooseSubtitles(page, `file:${app.files['Playback.S01E02.srt']}`)
  await expectCues(page, 'Middle subtitle')
  const middle = await page.locator('#video').evaluate(v => [...v.textTracks[0].cues].find(c => c.text === 'Middle subtitle').startTime)
  expect(middle).toBe(30)
  const hls = await page.request.get(`${app.origin}/api/debug`).then(r => r.json())
  expect(hls.serverConversion).toBe(false)
})

test('a browser that cannot repackage gets the file repackaged in Node and plays the HLS', async ({ page, app }) => {
  await page.route('**/api/play', async route => {
    if (route.request().method() !== 'POST') return route.continue()
    const body = route.request().postDataJSON()
    await route.continue({ postData: JSON.stringify({ ...body, browserRemux: false }) })
  })
  const decision = await openPlayer(page, app, remux)
  expect(decision.mode).toBe('remux')
  expect(decision.session).toEqual(expect.any(String))
  expect(decision.offset).toBeUndefined()
  expect(decision.growing).toBe(false)
  expect(decision.subtitles).toEqual([])
  const playlist = await page.request.get(`${app.origin}/hls/${decision.session}/index.m3u8`)
  expect(playlist.ok()).toBeTruthy()
  const text = await playlist.text()
  expect(text).toContain('#EXT-X-MAP:URI="init.mp4"')
  expect(text).toContain('#EXT-X-PLAYLIST-TYPE:VOD') // the whole file, as with ffmpeg
  // A seek is an ordinary seek here too: the Node conversion follows it
  const plays = countPlays(page)
  await seek(page, 60)
  await expect.poll(() => page.locator('#video').evaluate(v => v.currentTime)).toBeGreaterThanOrEqual(60)
  await expectPlaying(page)
  expect(plays).toEqual([])
})
