import { test, expect } from './fixtures.js'
import { direct, remux, openPlayer, expectPlaying, showChrome } from './helpers.js'

const explanation = page => page.locator('#playback-status')

// Gate actual responses; media, decisions, encoding and production diagnostics
// remain real. A completed encoder cannot satisfy a blocked browser response.
async function holdPlaylists (page) {
  let release
  const gate = new Promise(resolve => { release = resolve })
  await page.route('**/hls/*/index.m3u8', async route => {
    const response = await route.fetch()
    await gate
    await route.fulfill({ response }).catch(() => {})
  })
  return release
}

test('cached HLS delivery wait shows flow, preserves Diagnostics/focus, and recovers without notices erasing it', async ({ page, app }) => {
  const release = await holdPlaylists(page)
  try {
    await page.goto(app.player(remux))
    await expect(explanation(page)).toHaveAttribute('data-reason', 'browser')
    await expect(explanation(page).locator('[data-stage="server"] .flow-state')).toHaveText('100% local')
    const why = explanation(page).locator('.playback-why summary')
    await why.click()
    await expect(explanation(page).locator('.playback-facts')).toContainText('copying H.264')
    // A transient speed notice and several status/elapsed updates cannot replace it.
    await page.keyboard.press('>')
    await expect(explanation(page).locator('.playback-facts')).toContainText('1.25×')
    await expect.poll(() => explanation(page).locator('.playback-elapsed').innerText()).toMatch(/Waiting [4-9]|Waiting \d{2}/)
    await expect(explanation(page).locator('.playback-why')).toHaveAttribute('open', '')
    await expect(why).toBeFocused()
    release()
    await expectPlaying(page)
    await expect(explanation(page)).toBeHidden()
  } finally { release() }
})

for (const width of [1100, 375, 320]) {
  test(`pinned flow observes direct playback and pause without resizing or blocking the video at ${width}px`, async ({ page, app }) => {
    await page.setViewportSize({ width, height: 812 })
    await openPlayer(page, app, direct)
    const before = await page.locator('#stage').boundingBox()
    await showChrome(page)
    await page.getByRole('button', { name: 'More', exact: true }).click()
    await page.getByRole('menuitemradio', { name: 'Playback flow', exact: true }).click()
    await expect(explanation(page)).toHaveAttribute('data-pinned', 'true')
    await expect(explanation(page)).toHaveClass(/debug/)
    for (const node of await explanation(page).locator('.flow-node').all()) await expect(node).toBeInViewport({ ratio: 1 })
    await expect(page.locator('#stage')).not.toHaveClass(/has-playback-wait/)
    await expect(explanation(page).locator('[data-stage="prepare"] .flow-state')).toHaveText('Bypassed')
    expect((await page.locator('#stage').boundingBox()).height).toBe(before.height)
    await showChrome(page)
    await page.getByRole('button', { name: 'Pause', exact: true }).click()
    await expect(explanation(page)).toHaveAttribute('data-reason', 'paused')
    await explanation(page).getByRole('button', { name: 'Hide flow', exact: true }).click()
    await expect(explanation(page)).toBeHidden()
  })
}

for (const width of [1100, 560, 375, 320]) {
  test(`flow positions, inspection, and Diagnostics survive reason changes at ${width}px`, async ({ page, app }, testInfo) => {
    await page.setViewportSize({ width, height: 900 })
    const release = await holdPlaylists(page)
    let state = 'browser'
    await page.route('**/api/torrents/*/status?*', async route => {
      const response = await route.fetch()
      const body = await response.json()
      if (body.loaded && body.session) {
        body.file.progress = state === 'source' ? 0.54 : 1
        body.session.readyUntil = state === 'browser' ? 42 : 0
        body.session.speed = state === 'browser' ? 2.1 : 0.6
        body.session.running = true
        body.session.paused = false
        body.session.failed = state === 'failed'
        body.session.error = state === 'failed' ? `Fixture conversion stopped: ${'long diagnostic detail '.repeat(40)}` : null
      }
      await route.fulfill({ response, json: body })
    })
    try {
      await page.goto(app.player(remux))
      await expect(explanation(page)).toHaveAttribute('data-reason', 'browser')
      const summary = explanation(page).locator('.playback-why summary')
      await explanation(page).getByRole('button', { name: /^Server:/ }).click()
      await expect(explanation(page).locator('.flow-meter')).toHaveAttribute('aria-valuenow', '100')
      await summary.click()
      await expect(summary).toBeFocused()
      const coordinates = () => explanation(page).evaluate(root => ['.playback-flow', '.flow-inspector', '.flow-footer'].map(selector => {
        const r = root.querySelector(selector).getBoundingClientRect()
        return [r.x, r.y, r.width, r.height]
      }))
      const before = await coordinates()
      for (const [next, reason] of [['source', 'peers'], ['conversion', 'conversion'], ['failed', 'conversion-error'], ['browser', 'browser']]) {
        state = next
        await expect(explanation(page)).toHaveAttribute('data-reason', reason)
        await expect(explanation(page).locator('.playback-why')).toHaveAttribute('open', '')
        await expect(summary).toBeFocused()
        await expect(explanation(page).locator('.flow-inspector')).toHaveAttribute('data-stage', 'server')
        expect(await coordinates()).toEqual(before)
      }
      await summary.click()
      await explanation(page).getByRole('button', { name: 'Follow current wait', exact: true }).click()
      await expect(explanation(page).locator('.flow-inspector')).toHaveAttribute('data-stage', 'player')
      await expect(explanation(page).locator('.flow-meter')).not.toHaveAttribute('aria-valuenow')
      expect(await explanation(page).evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
      await page.screenshot({ path: testInfo.outputPath(`flow-${width}.png`) })
      release()
      await expectPlaying(page)
      await expect(explanation(page)).toBeHidden()
    } finally { release() }
  })
}

test('short landscape waits keep recovery and stage details reachable in fullscreen', async ({ page, app }, testInfo) => {
  await page.setViewportSize({ width: 812, height: 375 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const release = await holdPlaylists(page)
  try {
    await page.goto(app.player(remux))
    await expect(explanation(page)).toHaveAttribute('data-reason', 'browser')
    await page.getByRole('button', { name: 'Fullscreen', exact: true }).click()
    await expect.poll(() => page.evaluate(() => document.fullscreenElement?.id)).toBe('stage')
    await explanation(page).getByRole('button', { name: /^Server:/ }).click()
    await explanation(page).locator('.playback-why summary').click()
    await expect(explanation(page).locator('.playback-facts')).toContainText('File fully downloaded')
    await explanation(page).locator('.playback-why summary').click()
    await explanation(page).getByRole('button', { name: 'Open in player', exact: true }).click()
    await expect(explanation(page).getByRole('button', { name: 'Copy stream link', exact: true })).toBeVisible()
    const style = await explanation(page).locator('[data-state="working"] .flow-symbol').first().evaluate(el => getComputedStyle(el, '::after').animationName)
    expect(style).toBe('none')
    await page.screenshot({ path: testInfo.outputPath('flow-short-landscape.png') })
    await page.keyboard.press('Escape')
    release()
    await expectPlaying(page)
  } finally { release() }
})

test.describe('touch and larger text', () => {
  test.use({ hasTouch: true, viewport: { width: 375, height: 812 } })
  test('flow controls remain reachable with larger text and touch targets', async ({ page, app }, testInfo) => {
    const release = await holdPlaylists(page)
    try {
      await page.goto(app.player(remux))
      await expect(explanation(page)).toHaveAttribute('data-reason', 'browser')
      await expect(explanation(page).locator('h2')).toBeInViewport()
      await page.addStyleTag({ content: '#playback-status { zoom: 1.25; }' })
      const targets = explanation(page).locator('.flow-node, .flow-pin, .flow-follow')
      for (const size of await targets.evaluateAll(els => els.map(el => ({ width: el.getBoundingClientRect().width, height: el.getBoundingClientRect().height })))) {
        expect(size.width).toBeGreaterThanOrEqual(44)
        expect(size.height).toBeGreaterThanOrEqual(44)
      }
      await explanation(page).getByRole('button', { name: /^Server:/ }).click()
      await expect(explanation(page).locator('.flow-meter')).toHaveAttribute('aria-valuenow', '100')
      await explanation(page).locator('.playback-why summary').click()
      await expect(explanation(page).locator('.playback-facts')).toContainText('Entire torrent')
      expect(await explanation(page).locator('.playback-reason').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
      await page.screenshot({ path: testInfo.outputPath('flow-large-text-touch.png') })
      release()
      await expectPlaying(page)
    } finally { release() }
  })
})

test('waiting reasons and their actions fit a phone and remain inside fullscreen', async ({ page, app }) => {
  await page.setViewportSize({ width: 375, height: 812 })
  const release = await holdPlaylists(page)
  try {
    await page.goto(app.player(remux))
    await expect(explanation(page)).toHaveAttribute('data-reason', 'browser')
    const bounds = await explanation(page).evaluate(el => {
      const r = el.getBoundingClientRect()
      const chrome = document.querySelector('#chrome').getBoundingClientRect()
      const content = el.querySelector('.playback-reason').getBoundingClientRect()
      return { noOverflow: el.scrollWidth <= el.clientWidth, inViewport: r.right <= innerWidth, aboveControls: content.bottom <= chrome.bottom - 40 }
    })
    expect(bounds).toEqual({ noOverflow: true, inViewport: true, aboveControls: true })
    await page.getByRole('button', { name: 'Fullscreen', exact: true }).click()
    await expect.poll(() => page.evaluate(() => document.fullscreenElement?.id)).toBe('stage')
    await explanation(page).getByRole('button', { name: 'Open in player', exact: true }).click()
    await expect(explanation(page).getByRole('button', { name: 'Copy stream link', exact: true })).toBeVisible()
    await page.keyboard.press('Escape')
    release()
    await expectPlaying(page)
    await expect(explanation(page)).toBeHidden()
  } finally { release() }
})

test('normal direct playback and a deliberate pause have no buffering explanation', async ({ page, app }) => {
  await openPlayer(page, app, direct)
  await expect(explanation(page)).toBeHidden()
  await showChrome(page)
  await page.getByRole('button', { name: 'Pause', exact: true }).click()
  await expect.poll(() => page.locator('#video').evaluate(v => v.paused)).toBe(true)
  await expect(explanation(page)).toBeHidden()
  await page.getByRole('button', { name: 'Play', exact: true }).click()
  await expectPlaying(page)
  await expect(explanation(page)).toBeHidden()
})

test('a lost session is explained while waiting, and retry owns the replacement', async ({ page, app }) => {
  const release = await holdPlaylists(page)
  try {
    const response = page.waitForResponse(r => r.url().endsWith('/api/play') && r.request().method() === 'POST')
    await page.goto(app.player(remux))
    const decision = await (await response).json()
    await expect(explanation(page)).toHaveAttribute('data-reason', 'browser')
    await explanation(page).getByRole('button', { name: 'Open in player', exact: true }).click()
    const copy = explanation(page).getByRole('button', { name: 'Copy stream link', exact: true })
    await copy.focus()
    await page.request.delete(`${app.origin}/api/play/${decision.session}`)
    await expect(explanation(page)).toHaveAttribute('data-reason', 'session-lost')
    await expect(copy).toBeVisible()
    await expect(copy).toBeFocused()
    const replacement = page.waitForResponse(r => r.url().endsWith('/api/play') && r.request().method() === 'POST')
    await explanation(page).getByRole('button', { name: 'Try again', exact: true }).click()
    release()
    expect((await (await replacement).json()).session).not.toBe(decision.session)
    await expectPlaying(page)
    await expect(explanation(page)).toBeHidden()
  } finally { release() }
})

test('out-of-date diagnostics stop claiming a cause and recover when status returns', async ({ page, app }) => {
  const release = await holdPlaylists(page)
  let unavailable = false
  await page.route('**/api/torrents/*/status?*', route => unavailable ? route.abort() : route.continue())
  try {
    await page.goto(app.player(remux))
    await expect(explanation(page)).toHaveAttribute('data-reason', 'browser')
    unavailable = true
    await expect(explanation(page)).toHaveAttribute('data-reason', 'unknown')
    await expect(explanation(page)).not.toContainText('File fully downloaded')
    unavailable = false
    await expect(explanation(page)).toHaveAttribute('data-reason', 'browser')
    release()
    await expectPlaying(page)
    await expect(explanation(page)).toBeHidden()
  } finally { release() }
})

test('blocked autoplay explains the needed gesture and the real Play action recovers', async ({ page, app }) => {
  await page.addInitScript(() => {
    const play = HTMLMediaElement.prototype.play
    let blocked = true
    document.addEventListener('click', () => { blocked = false }, { once: true, capture: true })
    HTMLMediaElement.prototype.play = function () {
      return blocked ? Promise.reject(new DOMException('Fixture autoplay restriction', 'NotAllowedError')) : play.call(this)
    }
  })
  await page.goto(app.player(direct))
  await expect(explanation(page)).toHaveAttribute('data-reason', 'autoplay')
  await explanation(page).getByRole('button', { name: 'Play', exact: true }).click()
  await expectPlaying(page)
  await expect(explanation(page)).toBeHidden()
})
