// Regressions found reviewing the React migration (PR #33), kept for the vanilla client so both are held to the same behaviour.
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

test('search input does not take focus when Back returns to results', async ({ page, app }) => {
  await page.goto(`${app.origin}/explore`)
  await expect(page.locator('.topsearch input')).toHaveValue('')
  await page.locator('.topsearch input').fill('Playback')
  await page.locator('.topsearch input').press('Enter')
  await expect(page.locator('#results li')).toHaveCount(1)
  await page.locator('#results .title').click()
  await page.locator('#back').click()
  await expect(page.locator('#results li')).toHaveCount(1)
  await expect(page.locator('.topsearch input')).not.toBeFocused()
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

let baseline
const changedKeys = ['sources', 'search.timeoutS', 'cache.maxGb']
test.beforeEach(async ({ request, app }) => {
  baseline = (await (await request.get(`${app.origin}/api/settings`)).json()).values
})
test.afterEach(async ({ request, app }) => {
  const current = (await (await request.get(`${app.origin}/api/settings`)).json()).values
  const changes = Object.fromEntries(changedKeys.filter(key => JSON.stringify(current[key]) !== JSON.stringify(baseline[key])).map(key => [key, baseline[key]]))
  if (Object.keys(changes).length) {
    const response = await request.patch(`${app.origin}/api/settings`, { headers: { Origin: app.origin }, data: changes })
    expect(response.ok()).toBe(true)
  }
})

test('source controls and Discard stay disabled throughout a pending save', async ({ page, app }) => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  let saving = false
  await page.route('**/api/settings', async route => {
    if (route.request().method() === 'PATCH') {
      saving = true
      await gate
    }
    await route.continue()
  })
  await page.goto(`${app.origin}/settings`)
  await page.getByRole('button', { name: '+ Add source' }).click()
  const url = page.getByRole('textbox', { name: 'Source URL, source 2', exact: true })
  await url.fill(`${app.origin}/fixture-feed`)
  await page.locator('#savebar-save').click()
  await expect.poll(() => saving).toBe(true)
  await expect(url).toBeDisabled()
  await expect(page.getByRole('combobox', { name: 'Source type, source 2' })).toBeDisabled()
  await expect(page.getByRole('textbox', { name: 'API key, source 2', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: '+ Add source' })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Remove source 2' })).toBeDisabled()
  await expect(page.locator('#savebar-discard')).toBeDisabled()
  release()
  await expect(page.locator('#savebar-count')).toContainText('Saved:')
  await expect(url).toBeEnabled()
  await expect(url).toHaveValue(`${app.origin}/fixture-feed`)
  await expect.poll(async () => (await (await page.request.get(`${app.origin}/api/settings`)).json()).values.sources[0].url).toBe(`${app.origin}/fixture-feed`)
})

test('returning from playback and Next retains the original Results link', async ({ page, app }) => {
  await page.goto(`${app.origin}/?q=Playback`)
  await page.locator('#results .title').click()
  await page.getByRole('link', { name: 'S01E01', exact: true }).click()
  await expectPlaying(page)
  await page.getByRole('link', { name: 'Next: S01E02', exact: true }).click()
  await expectPlaying(page)
  await page.keyboard.press('n')
  await expect(page).toHaveURL(/\/3$/)
  await expectPlaying(page)
  await page.locator('#back').click()
  await expect(page.locator('#back')).toHaveText('← Results')
  await page.locator('#back').click()
  await expect(page).toHaveURL(`${app.origin}/?q=Playback`)
  await expect(page.locator('#results li')).toHaveCount(1)
  await expect(page.locator('.topsearch input')).toHaveValue('Playback')
})

test('Settings reentry refreshes server fields and mounted focus refresh preserves drafts', async ({ page, app }) => {
  const settings = `${app.origin}/api/settings`
  const patch = async changes => {
    const response = await page.request.patch(settings, { headers: { Origin: app.origin }, data: changes })
    expect(response.ok()).toBe(true)
  }
  const initial = await (await page.request.get(settings)).json()
  await page.goto(`${app.origin}/settings`)
  await expect(page.getByLabel('Search timeout (s)', { exact: true })).toHaveValue(String(initial.values['search.timeoutS']))
  await page.getByRole('link', { name: 'Explore', exact: true }).click()
  await patch({ 'search.timeoutS': 37, sources: [{ id: 'external', type: 'torznab', url: `${app.origin}/external-feed`, apiKey: '' }] })
  await page.getByRole('link', { name: 'Settings', exact: true }).click()
  await expect(page.getByLabel('Search timeout (s)', { exact: true })).toHaveValue('37')
  await expect(page.getByLabel('Source URL, source 2', { exact: true })).toHaveValue(`${app.origin}/external-feed`)
  await page.getByLabel('Search timeout (s)', { exact: true }).fill('38')
  await page.getByLabel('Source URL, source 2', { exact: true }).fill(`${app.origin}/draft-feed`)
  await patch({ 'search.timeoutS': 39, 'cache.maxGb': 43, sources: [{ id: 'external', type: 'torznab', url: `${app.origin}/changed-feed`, apiKey: '' }] })
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    document.dispatchEvent(new Event('visibilitychange', { bubbles: true }))
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    document.dispatchEvent(new Event('visibilitychange', { bubbles: true }))
  })
  await expect(page.getByLabel('Torrent cache limit (GB)', { exact: true })).toHaveValue('43')
  await expect(page.getByLabel('Search timeout (s)', { exact: true })).toHaveValue('38')
  await expect(page.getByLabel('Source URL, source 2', { exact: true })).toHaveValue(`${app.origin}/draft-feed`)
  await page.locator('#savebar-discard').click()
  await expect(page.getByLabel('Search timeout (s)', { exact: true })).toHaveValue('39')
  await expect(page.getByLabel('Source URL, source 2', { exact: true })).toHaveValue(`${app.origin}/changed-feed`)
})

test('returning through Title after playback retains the filtered Explore destination', async ({ page, app }) => {
  const title = { type: 'movie', source: 'tmdb', id: '1', title: 'Return film', year: 2026, genres: [], links: [], releases: [{ infoHash: app.ih, name: 'Playback fixtures', seeders: 2, badges: [] }] }
  await page.route('**/api/explore?*', route => route.fulfill({ json: { titles: [title], hasMore: false } }))
  await page.route('**/api/explore/facets?*', route => route.fulfill({ json: { genres: [{ value: 'Drama', label: 'Drama', count: 1 }], years: [], resolutions: [] } }))
  await page.route('**/api/explore/latest?*', route => route.fulfill({ json: [] }))
  await page.route('**/api/title/**', route => route.fulfill({ json: title }))
  await page.goto(`${app.origin}/explore?genre=Drama`)
  await page.locator('#tiles .tile').click()
  await page.locator('#releases .title').click()
  await page.getByRole('link', { name: 'S01E01', exact: true }).click()
  await expectPlaying(page)
  await page.locator('#back').click()
  await expect(page.locator('#back')).toHaveText('← Return film')
  await page.locator('#back').click()
  await expect(page.locator('#back')).toHaveText('← Explore')
  await page.locator('#back').click()
  await expect(page).toHaveURL(`${app.origin}/explore?genre=Drama`)
  await expect(page.getByRole('button', { name: 'Drama 1', exact: true })).toHaveAttribute('aria-pressed', 'true')
})
