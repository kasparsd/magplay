import { test, expect } from './fixtures.js'
import { direct, expectPlaying } from './helpers.js'

test('Explore keeps facet choices while refreshing filters', async ({ page, app }) => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  let refreshing = false
  await page.route('**/api/explore/facets?*', async route => {
    if (new URL(route.request().url()).searchParams.get('genre')) {
      refreshing = true
      await gate
    }
    await route.fulfill({ json: { genres: [{ value: 'Drama', label: 'Drama', count: 2 }], years: [{ value: 2026, count: 2 }], resolutions: [{ value: 'V1080p', count: 2 }] } })
  })
  await page.route('**/api/explore?*', route => route.fulfill({ json: { titles: [], hasMore: false } }))
  await page.route('**/api/explore/latest?*', route => route.fulfill({ json: [] }))
  await page.goto(`${app.origin}/explore`)
  await page.getByRole('button', { name: 'Drama 2', exact: true }).click()
  await expect.poll(() => refreshing).toBe(true)
  await expect(page.getByRole('button', { name: 'Drama 2', exact: true })).toBeVisible()
  await expect(page.getByLabel('Year', { exact: true }).locator('option')).toHaveCount(2)
  await expect(page.getByLabel('Quality', { exact: true }).locator('option')).toHaveCount(2)
  release()
})

for (const [name, path, endpoint, progress] of [
  ['Search', '/?q=Retry', '**/api/search?*', 'Searching…'],
  ['Title', '/title/movie/tmdb/1', '**/api/title/**', 'Finding releases…'],
  ['Torrent', '/t/HASH', '**/api/torrents/HASH', 'Loading the file list…'],
  ['Explore', '/explore', '**/api/explore?*', 'Loading…'],
]) {
  test(`${name} retry shows progress while the request is pending`, async ({ page, app }) => {
    let release
    const gate = new Promise(resolve => { release = resolve })
    let requests = 0
    await page.route(endpoint.replace('HASH', app.ih), async route => {
      if (++requests > 1) await gate
      await route.fulfill({ status: 502, json: { error: 'Temporary failure' } })
    })
    await page.goto(app.origin + path.replace('HASH', app.ih))
    await expect(page.locator('#status')).toContainText('Temporary failure')
    await page.locator('#status .retry').click()
    await expect(page.locator('#status')).toContainText(progress)
    await expect(page.locator('#status .retry')).toHaveCount(0)
    release()
    await expect(page.locator('#status')).toContainText('Temporary failure')
  })
}

test('search input keeps its node and does not acquire focus from Back or a referrer', async ({ page, app }) => {
  await page.goto(`${app.origin}/explore`, { referer: `${app.origin}/?q=Unrelated` })
  await expect(page.locator('.topsearch input')).toHaveValue('')
  await page.locator('.topsearch input').fill('Playback')
  await page.locator('.topsearch input').evaluate(input => { window.originalSearchInput = input })
  await page.locator('.topsearch input').press('Enter')
  await expect(page.locator('#results li')).toHaveCount(1)
  expect(await page.locator('.topsearch input').evaluate(input => input === window.originalSearchInput)).toBe(true)
  await page.locator('#results .title').click()
  await page.locator('#back').click()
  await expect(page.locator('#results li')).toHaveCount(1)
  await expect(page.locator('.topsearch input')).not.toBeFocused()
  await page.goto(app.torrent, { referer: `${app.origin}/?q=Unrelated` })
  await expect(page.locator('#back')).not.toBeVisible()
})

test('fullscreen changes wake the Player controls', async ({ page, app }) => {
  await page.goto(app.player(direct))
  await expectPlaying(page)
  await page.mouse.move(0, 0)
  await expect(page.locator('#stage')).toHaveClass(/idle/, { timeout: 5000 })
  await page.evaluate(() => document.dispatchEvent(new Event('fullscreenchange')))
  await expect(page.locator('#stage')).not.toHaveClass(/idle/)
})

test('Player hides Picture in picture when the video forbids it', async ({ page, app }) => {
  await page.goto(app.player(direct))
  await expectPlaying(page)
  await page.getByRole('button', { name: 'More', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Picture in picture', exact: true })).toBeVisible()
  await page.locator('video').evaluate(video => { video.disablePictureInPicture = true })
  await expect(page.getByRole('button', { name: 'Picture in picture', exact: true })).toHaveCount(0)
})
