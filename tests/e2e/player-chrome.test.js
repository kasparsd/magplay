// The Player's overlay chrome: the same controls in every playback mode, menus in fullscreen,
// the seek tooltip, keys and remembered choices.
import { test, expect } from './fixtures.js'
import { chooseAudio, chooseSubtitles, countPlays, direct, expectCues, expectPlaying, long, openPlayer, playResponse, remux, sessionStatus, showChrome } from './helpers.js'

test('one chrome in direct and HLS modes, hiding while playing and back on pointer move', async ({ page, app }) => {
  for (const file of [direct, remux]) {
    await openPlayer(page, app, file)
    expect(await page.locator('#video').evaluate(v => v.controls)).toBe(false)
    for (const name of ['Pause', 'Mute', 'Fullscreen', 'More']) {
      await expect(page.getByRole('button', { name, exact: true })).toBeVisible()
    }
    await expect(page.getByRole('slider', { name: 'Position' })).toHaveAttribute('aria-valuetext', /^\d+:\d\d of 1:30$/)
    // Audio shows only for files with a choice of tracks
    await expect(page.locator('#audio-slot')).toBeVisible({ visible: file === remux })
    await page.mouse.move(5, 5) // off the stage
    await expect(page.locator('#stage')).toHaveClass(/idle/, { timeout: 5000 })
    await page.locator('#stage').hover()
    await expect(page.locator('#stage')).not.toHaveClass(/idle/)
    // Once faded, a click where the controls were brings them back instead of pausing
    const bar = await page.locator('#chrome .controls').boundingBox()
    await page.mouse.move(bar.x + bar.width / 2, bar.y + bar.height / 2)
    await expect(page.locator('#stage')).toHaveClass(/idle/, { timeout: 5000 })
    await page.mouse.down()
    await page.mouse.up()
    await expect(page.locator('#stage')).not.toHaveClass(/idle/)
    expect(await page.locator('#video').evaluate(v => v.paused)).toBe(false)
    // The played layer follows the playhead
    await expect.poll(() => page.locator('#layer-played').evaluate(n => parseFloat(n.style.width))).toBeGreaterThan(0)
  }
})

test('Audio and Subtitles menus work in fullscreen and stay inside the stage', async ({ page, app }) => {
  await openPlayer(page, app, remux)
  await showChrome(page)
  await page.getByRole('button', { name: 'Fullscreen', exact: true }).click()
  await expect.poll(() => page.evaluate(() => document.fullscreenElement?.id)).toBe('stage')
  await chooseSubtitles(page, 'embedded:0')
  await expectCues(page, 'First subtitle')
  await expect(page.locator('#subs-slot summary')).toHaveAttribute('aria-label', 'Subtitles: English')
  await showChrome(page)
  await page.locator('#audio-slot summary').click()
  const items = page.locator('#audio-slot .menu-items')
  await expect(items).toBeVisible()
  // The menu is placed when its toggle event runs, just after it opens
  await expect.poll(async () => {
    const [menuBox, stageBox] = await Promise.all([items.boundingBox(), page.locator('#stage').boundingBox()])
    return menuBox.x >= stageBox.x && menuBox.x + menuBox.width <= stageBox.x + stageBox.width && menuBox.y >= stageBox.y
  }).toBe(true)
  const switching = playResponse(page)
  await page.locator('#audio-slot .menu-items [data-value="1"]').click()
  expect((await (await switching).json()).mode).toBe('remux')
  expect(await page.evaluate(() => document.fullscreenElement?.id)).toBe('stage')
  await expectPlaying(page)
  await showChrome(page)
  await page.getByRole('button', { name: 'Exit fullscreen', exact: true }).click()
  await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(false)
})

test('menus close with Escape', async ({ page, app }) => {
  await openPlayer(page, app, remux)
  await showChrome(page)
  await page.locator('#more-slot summary').click()
  await expect(page.locator('#more-slot .menu-items')).toBeVisible()
  await expect(page.locator('#more-slot .menu-items')).toContainText('Download file')
  await page.keyboard.press('Escape')
  await expect(page.locator('#more-slot .menu-items')).toBeHidden()
  await expect(page.locator('#more-slot summary')).toBeFocused()
})

test('the seek tooltip says when a jump has to be converted first, and the jump plays without a new session', async ({ page, app }) => {
  const decision = await openPlayer(page, app, long, 160)
  await expect.poll(async () => (await sessionStatus(page, app, decision)).paused, { timeout: 30_000 }).toBe(true)
  await showChrome(page)
  const track = await page.locator('#seekbar .track').boundingBox()
  const at = fraction => [track.x + track.width * fraction, track.y + track.height / 2]
  await page.mouse.move(...at(0.02))
  await expect(page.locator('#seektip')).toBeVisible()
  await expect(page.locator('#seektip span')).toHaveText('')
  await page.mouse.move(...at(480 / 600))
  await expect(page.locator('#seektip b')).toHaveText(/^(7:59|8:00)$/)
  await expect(page.locator('#seektip span')).toHaveText('Converts from here')
  const plays = countPlays(page)
  await page.mouse.click(...at(480 / 600))
  await expect.poll(() => page.locator('#video').evaluate(v => v.currentTime)).toBeGreaterThanOrEqual(475)
  await expectPlaying(page, 160)
  expect(plays).toEqual([])
})

test('keys work and choices are remembered for the next file', async ({ page, app }) => {
  await openPlayer(page, app, remux)
  await page.locator('h1').click() // focus the page, not a control
  await page.keyboard.press('k')
  await expect.poll(() => page.locator('#video').evaluate(v => v.paused)).toBe(true)
  await page.keyboard.press('Space')
  await expect.poll(() => page.locator('#video').evaluate(v => v.paused)).toBe(false)
  const before = await page.locator('#seek').inputValue().then(Number)
  await page.keyboard.press('l')
  await expect.poll(() => page.locator('#seek').inputValue().then(Number)).toBeGreaterThanOrEqual(before + 9)
  await page.keyboard.press('m')
  await expect.poll(() => page.locator('#video').evaluate(v => v.muted)).toBe(true)
  await page.keyboard.press('m')
  await page.keyboard.press('ArrowDown')
  await expect.poll(() => page.locator('#video').evaluate(v => v.volume)).toBeCloseTo(0.9, 2)
  await page.keyboard.press('>')
  await expect.poll(() => page.locator('#video').evaluate(v => v.playbackRate)).toBe(1.25)
  await page.keyboard.press('c')
  await expect(page.locator('#subs-slot summary')).toHaveAttribute('aria-label', 'Subtitles: English')
  await expectCues(page, 'First subtitle')
  await page.keyboard.press('?')
  await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeHidden()
  const stored = await page.evaluate(() => Object.fromEntries(['volume', 'muted', 'speed', 'subtitleLanguage'].map(k => [k, JSON.parse(localStorage.getItem(`magplay:player:${k}`))])))
  expect(stored).toEqual({ volume: 0.9, muted: false, speed: 1.25, subtitleLanguage: 'eng' })
  // The next file picks up the remembered speed and volume
  await openPlayer(page, app, direct)
  expect(await page.locator('#video').evaluate(v => [v.playbackRate, v.volume])).toEqual([1.25, 0.9])
})

test('the remembered audio language picks the track on the next file', async ({ page, app }) => {
  await openPlayer(page, app, remux)
  const switching = playResponse(page)
  await chooseAudio(page, 1)
  await switching
  await expectPlaying(page)
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('magplay:player:audioLanguage')))).toBe('lav')
  const response = playResponse(page)
  await page.reload()
  const resume = page.getByRole('button', { name: 'Start over', exact: true })
  await resume.or(page.locator('#video[src]')).first().waitFor()
  if (await resume.isVisible()) await resume.click()
  expect((await response).request().postDataJSON().audio).toBe(1)
  await expectPlaying(page)
})
