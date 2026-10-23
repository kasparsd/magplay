import { test, expect } from './fixtures.js'

test('catalog navigation keeps filters, cached pages and query without a document reload', async ({ page, app }, testInfo) => {
  const title = { type: 'movie', source: 'tmdb', id: '1', title: 'Catalog film', year: 2026, rating: 8, runtime: 90, overview: 'A fixture film.', genres: ['Drama'], links: [], seeders: 4, playable: true, best: app.ih }
  const release = { infoHash: app.ih, name: 'Catalog.1080p', size: 1000, seeders: 4, episode: null, publishedAt: null, badges: [], playbackEffort: 'direct', likelyDirect: true, warning: null }
  let browseRequests = 0
  await page.route('**/api/explore?*', route => {
    browseRequests++
    const url = new URL(route.request().url())
    const second = url.searchParams.get('page') === '2'
    return route.fulfill({ json: { titles: second ? [title, { ...title, id: '2', title: 'Second film' }] : [title], hasMore: !second } })
  })
  await page.route('**/api/explore/facets?*', route => route.fulfill({ json: { genres: [{ value: 'Drama', label: 'Drama', count: 2 }], years: [{ value: 2026, count: 2 }], resolutions: [] } }))
  await page.route('**/api/explore/latest?*', route => route.fulfill({ json: [] }))
  await page.route('**/api/title/**', route => route.fulfill({ json: { ...title, releases: [release], truncated: true } }))
  await page.goto(`${app.origin}/?q=Playback`)
  await page.getByRole('link', { name: 'Explore', exact: true }).click()
  await page.evaluate(() => { window.catalogDocument = 'same' })
  await page.getByRole('button', { name: 'Drama 2', exact: true }).click()
  await expect(page).toHaveURL(/genre=Drama/)
  await expect(page.locator('.topsearch input')).toHaveValue('Playback')
  await page.getByRole('button', { name: 'Show more' }).click()
  await expect(page.locator('#tiles .tile')).toHaveCount(2)
  await testInfo.attach('explore desktop', { body: await page.screenshot({ path: testInfo.outputPath('explore-desktop.png') }), contentType: 'image/png' })
  await page.setViewportSize({ width: 375, height: 812 })
  await testInfo.attach('explore phone', { body: await page.screenshot({ path: testInfo.outputPath('explore-phone.png') }), contentType: 'image/png' })
  await page.setViewportSize({ width: 1100, height: 800 })
  const count = browseRequests
  await page.locator('#tiles .tile').first().click()
  await expect(page.locator('#releases')).toContainText('likely direct')
  await expect(page).toHaveURL(/year=2026/)
  await expect(page.locator('#header h1')).toContainText('2026')
  await expect(page.locator('#header')).toContainText('Best release')
  await testInfo.attach('title desktop', { body: await page.screenshot({ path: testInfo.outputPath('title-desktop.png') }), contentType: 'image/png' })
  await page.goBack()
  await expect(page.getByRole('button', { name: 'Drama 2' })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('#tiles .tile')).toHaveCount(2)
  expect(browseRequests).toBe(count)
  expect(await page.evaluate(() => window.catalogDocument)).toBe('same')
  await page.locator('#tiles .tile').first().click()
  await page.locator('#back').click()
  await expect(page).toHaveURL(/genre=Drama/)
  await expect(page).toHaveTitle('Explore · magplay')
  await page.locator('.topsearch input').fill('Playback')
  await page.locator('.topsearch input').press('Enter')
  await expect(page.locator('#results li')).toHaveCount(1)
  await expect(page.locator('#search input')).toHaveValue('Playback')
  expect(await page.evaluate(() => window.catalogDocument)).toBe('same')
  await expect(page).toHaveTitle('magplay')
  expect(await page.evaluate(() => sessionStorage.getItem('lastSearch'))).toBeNull()
})

test('explore restores URL filters and retries a failed next page without duplicates', async ({ page, app }) => {
  const title = { type: 'movie', source: 'tmdb', id: '1', title: 'Current film', year: null, rating: null, genres: [], seeders: 2, playable: false }
  let fail = true
  await page.route('**/api/explore?*', async route => {
    const url = new URL(route.request().url())
    if (url.searchParams.get('page') === '2' && fail) {
      fail = false
      return route.fulfill({ status: 502, json: { error: 'Next page failed' } })
    }
    return route.fulfill({ json: { titles: [title], hasMore: url.searchParams.get('page') !== '2' } })
  })
  await page.route('**/api/explore/facets?*', route => route.fulfill({ status: 502, json: { error: 'No counts' } }))
  await page.route('**/api/explore/latest?*', route => route.fulfill({ json: [] }))
  await page.goto(`${app.origin}/explore?genre=Rare&year=1990&res=V720p`)
  await expect(page.getByRole('button', { name: 'Rare', exact: true })).toHaveCount(0) // facet failure has a retry
  await expect(page.locator('#genres')).toContainText('Genre counts didn\'t arrive in time.')
  await page.getByRole('button', { name: 'Show more' }).click()
  await expect(page.locator('#status')).toContainText('Next page failed')
  await page.locator('#status').getByRole('button', { name: 'Try again' }).click()
  await expect(page.locator('#status')).toBeEmpty()
  await expect(page.locator('#tiles .tile')).toHaveCount(1)
  await page.getByLabel('Type', { exact: true }).selectOption('tv_show')
  await expect(page.getByLabel('Year', { exact: true })).toHaveValue('')
  await expect(page.getByLabel('Quality', { exact: true })).toHaveValue('')
  await page.goBack()
  await expect(page.getByLabel('Year', { exact: true })).toHaveValue('1990')
})

test('search ignores a late response after the query changes and preserves category history', async ({ page, app }) => {
  let finishSlow
  const slow = new Promise(resolve => { finishSlow = resolve })
  let started = false
  await page.route('**/api/search?*', async route => {
    const params = new URL(route.request().url()).searchParams
    if (params.get('q') === 'Slow') {
      started = true
      await slow
    }
    return route.fulfill({ json: { sources: [], results: [{ title: params.get('q'), infoHash: app.ih, magnet: null, linkId: null, sources: [], badges: [], size: null, seeders: null, warning: null, playbackEffort: null }] } })
  })
  await page.goto(`${app.origin}/?q=Slow`)
  await expect.poll(() => started).toBe(true)
  await page.locator('#search input').fill('Fast')
  await page.locator('#search input').press('Enter')
  await expect(page.locator('#results')).toContainText('Fast')
  finishSlow()
  await page.getByText('Movies', { exact: true }).click()
  await expect(page).toHaveURL(/cat=2000/)
  await expect(page.getByRole('radio', { name: 'Movies', exact: true })).toBeChecked()
  await expect(page.locator('#results')).toContainText('Fast')
  await expect(page.locator('#results')).not.toContainText('Slow')
  await page.goBack()
  await expect(page.locator('#search input')).toHaveValue('Slow')
  await expect(page.getByRole('radio', { name: 'All', exact: true })).toBeChecked()
})
