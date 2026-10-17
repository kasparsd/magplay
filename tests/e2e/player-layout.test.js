// Theater layout: the video keeps its aspect ratio and, with the title row, fits the viewport.
import { test, expect } from './fixtures.js'
import { direct, expectPlaying, openPlayer } from './helpers.js'

const sizes = [
  { width: 1440, height: 900, titleAboveFold: true },
  { width: 1280, height: 800, titleAboveFold: true },
  { width: 800, height: 600, titleAboveFold: true },
  { width: 375, height: 812, titleAboveFold: true },
  // Phones in landscape give the video the height under the top bar; the title row is one scroll away
  { width: 812, height: 375, titleAboveFold: false },
]

test('the video box keeps its aspect ratio and fits the viewport at desktop and phone sizes', async ({ page, app }) => {
  await openPlayer(page, app, direct) // a 16:9 file
  for (const { width, height, titleAboveFold } of sizes) {
    await page.setViewportSize({ width, height })
    await page.reload()
    await page.getByRole('button', { name: 'Start over', exact: true }).or(page.locator('#video[src]')).first().waitFor()
    const startOver = page.getByRole('button', { name: 'Start over', exact: true })
    if (await startOver.isVisible()) await startOver.click()
    await expectPlaying(page)
    const box = await page.locator('#stage').boundingBox()
    const label = `${width}×${height}`
    expect(Math.abs(box.width / box.height - 16 / 9), `${label}: aspect ratio`).toBeLessThan(0.02)
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

test('the title row names the release and episode; the file name moves into Details', async ({ page, app }) => {
  await openPlayer(page, app, direct)
  await expect(page.locator('h1')).toHaveText('Playback fixtures · S01E01')
  await expect(page.locator('#back')).toHaveText('← Playback fixtures')
  await page.getByRole('button', { name: 'ⓘ Details' }).click()
  await expect(page.locator('#facts')).toContainText('Playback.S01E01.mp4')
  await expect(page.getByRole('button', { name: 'ⓘ Details' })).toHaveAttribute('aria-expanded', 'true')
})
