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

test('cached HLS delivery wait shows evidence, preserves Why/focus, and recovers without notices erasing it', async ({ page, app }) => {
  const release = await holdPlaylists(page)
  try {
    await page.goto(app.player(remux))
    await expect(explanation(page)).toHaveAttribute('data-reason', 'browser')
    await expect(explanation(page)).toContainText('File fully downloaded')
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
    await page.request.delete(`${app.origin}/api/play/${decision.session}`)
    await expect(explanation(page)).toHaveAttribute('data-reason', 'session-lost')
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
