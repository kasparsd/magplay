// Theater layout: the video keeps its aspect ratio and, with the title row, fits the viewport.
import { test, expect } from './fixtures.js'
import { direct, expectPlaying, openPlayer, scope, showChrome } from './helpers.js'

const sizes = [
  { width: 1440, height: 900, titleAboveFold: true },
  { width: 1280, height: 800, titleAboveFold: true },
  { width: 800, height: 600, titleAboveFold: true },
  { width: 375, height: 812, titleAboveFold: true },
  // Phones in landscape give the video the height under the top bar; the title row is one scroll away
  { width: 812, height: 375, titleAboveFold: false },
]

const files = [
  { name: '16:9', file: direct, width: 320, ratio: 16 / 9 },
  { name: '2.39:1', file: scope, width: 478, ratio: 478 / 200 },
]

for (const { name, file, width: videoWidth, ratio } of files) {
  test(`the ${name} video box keeps its aspect ratio and fits the viewport at desktop and phone sizes`, async ({ page, app }) => {
    await openPlayer(page, app, file, videoWidth)
    for (const { width, height, titleAboveFold } of sizes) {
      await page.setViewportSize({ width, height })
      await page.reload()
      await page.getByRole('button', { name: 'Start over', exact: true }).or(page.locator('#video[src]')).first().waitFor()
      const startOver = page.getByRole('button', { name: 'Start over', exact: true })
      if (await startOver.isVisible()) await startOver.click()
      await expectPlaying(page, videoWidth)
      const box = await page.locator('#stage').boundingBox()
      const label = `${name} at ${width}×${height}`
      expect(Math.abs(box.width / box.height - ratio), `${label}: aspect ratio`).toBeLessThan(0.02)
      expect(box.y + box.height, `${label}: video bottom`).toBeLessThanOrEqual(height + 0.5)
      expect(box.width, `${label}: video width`).toBeLessThanOrEqual(width)
      const row = await page.locator('#titlerow').boundingBox()
      // Width-bound sizes use the full width; height-bound ones the height left by the top bar (and the title row)
      const room = height - box.y - (titleAboveFold ? row.height : 0)
      expect(Math.max(box.width / width, box.height / room), `${label}: as large as it fits`).toBeGreaterThan(0.98)
      if (titleAboveFold) expect(row.y + row.height, `${label}: title row`).toBeLessThanOrEqual(height + 0.5)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), `${label}: no sideways scroll`).toBe(true)
    }
  })
}

// Phone portrait and landscape both leave the stage under 600 px wide
for (const { width, height } of [{ width: 375, height: 812 }, { width: 812, height: 375 }]) {
  test(`below 600 px of stage the chrome drops ±10 s, volume and Speed, and keeps 40 px targets at ${width}×${height}`, async ({ page, app }) => {
    await page.setViewportSize({ width, height })
    await openPlayer(page, app, direct)
    const stage = await page.locator('#stage').boundingBox()
    expect(stage.width).toBeLessThan(600)
    await showChrome(page)
    for (const id of ['back10', 'fwd10', 'volume', 'speed-slot']) await expect(page.locator(`#${id}`), id).toBeHidden()
    // Next is an icon instead of a labelled pill
    await expect(page.locator('#next .narrow-only')).toBeVisible()
    await expect(page.locator('#next .wide-only')).toBeHidden()
    const targets = page.locator('.chrome .controls').locator('button, summary, a').filter({ visible: true })
    expect(await targets.count()).toBeGreaterThanOrEqual(6)
    for (const box of await targets.evaluateAll(els => els.map(e => ({ label: e.getAttribute('aria-label') || e.textContent, ...e.getBoundingClientRect().toJSON() })))) {
      expect(Math.min(box.width, box.height), `${box.label}: touch target`).toBeGreaterThanOrEqual(40)
      expect(box.left, `${box.label}: inside the stage`).toBeGreaterThanOrEqual(stage.x - 0.5)
      expect(box.right, `${box.label}: inside the stage`).toBeLessThanOrEqual(stage.x + stage.width + 0.5)
    }
    // Speed moves into More
    await page.locator('#more-slot summary').click()
    const more = page.locator('#more-slot .menu-items')
    await expect(more.getByText('Speed', { exact: true })).toBeVisible()
    await expect(more.locator('[role="menuitemradio"], .choice').filter({ visible: true }).first()).toBeVisible()
    // menu() moves the list inside the stage in its toggle handler, which runs after the menu opens
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), { message: 'no sideways scroll' }).toBe(true)
  })
}

test('the title row names the release and episode; the file name moves into Details', async ({ page, app }) => {
  await openPlayer(page, app, direct)
  await expect(page.locator('h1')).toHaveText('Playback fixtures · S01E01')
  await expect(page.locator('#back')).toHaveText('← Playback fixtures')
  await page.getByRole('button', { name: 'ⓘ Details' }).click()
  await expect(page.locator('#facts')).toContainText('Playback.S01E01.mp4')
  // A readable container name, not ffprobe's "mov,mp4,m4a,3gp,3g2,mj2"
  await expect(page.locator('#facts dt:text-is("Container") + dd')).toHaveText('MP4')
  await expect(page.getByRole('button', { name: 'ⓘ Details' })).toHaveAttribute('aria-expanded', 'true')
})

test('the Player has the status button and Settings gear in its top bar, and the video still fits', async ({ page, app }) => {
  await page.setViewportSize({ width: 375, height: 812 })
  await openPlayer(page, app, direct)
  const bar = page.locator('header.topbar')
  const status = bar.locator('.status-button')
  await expect(status).toHaveAttribute('aria-label', /^Status: (all good|not checked yet|checking|\d+ problems?)$/)
  await expect(bar.getByRole('link', { name: 'Settings', exact: true })).toHaveAttribute('href', '/settings')
  // Once the checks are in, the stage still starts under the (possibly taller) top bar and fits the viewport
  await expect(status).toHaveAttribute('aria-label', /^Status: (all good|\d+ problems?)$/)
  await expect.poll(async () => {
    const [topbar, stage] = await Promise.all([bar.boundingBox(), page.locator('#stage').boundingBox()])
    return stage.y >= topbar.y + topbar.height - 0.5 && stage.y + stage.height <= 812.5
  }).toBe(true)
  await status.click()
  await expect(page.locator('.status-panel .status-check', { hasText: 'ffmpeg' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('.status-panel')).toBeHidden()
  await expectPlaying(page)
})
