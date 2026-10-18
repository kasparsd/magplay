import { test, expect } from './fixtures.js'

test('search results link back from the torrent page, and the header keeps the query', async ({ page, app }) => {
  await page.goto(`${app.origin}/?q=Playback`)
  const row = page.locator('#results li').filter({ hasText: 'Playback fixtures' })
  await expect(row).toContainText('1 seeder')
  await expect(row).not.toContainText('Local fixtures') // one source: no source label on every row
  await row.getByRole('link', { name: 'Playback fixtures', exact: true }).click()
  await expect(page).toHaveURL(app.torrent)
  await expect(page.locator('.topsearch input[name="q"]')).toHaveValue('Playback')
  await page.getByRole('link', { name: '← Results' }).click()
  await expect(page).toHaveURL(`${app.origin}/?q=Playback`)
  await expect(row).toBeVisible()

  // A direct visit has no search to go back to
  await page.goto(app.torrent)
  await expect(page.locator('#torrent .meta')).toBeVisible()
  await expect(page.locator('#back')).toBeHidden()
})

test('a new search is its own history entry', async ({ page, app }) => {
  await page.goto(`${app.origin}/?q=Playback`)
  await expect(page.locator('#results li')).toHaveCount(1)
  await page.locator('#search input[name="q"]').fill('Something else')
  await page.locator('#search').getByRole('button', { name: 'Search' }).click()
  await expect(page).toHaveURL(/q=Something\+else/)
  await page.goBack()
  await expect(page).toHaveURL(`${app.origin}/?q=Playback`)
  await expect(page.locator('#search input[name="q"]')).toHaveValue('Playback')
  await expect(page.locator('#results li')).toHaveCount(1)
})

test('a failed search says why and retries on the page', async ({ page, app }) => {
  let failures = 1
  await page.route('**/api/search?*', route => failures-- > 0
    ? route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ error: 'Local fixtures: HTTP 500' }) })
    : route.continue())
  await page.goto(`${app.origin}/?q=Playback`)
  await expect(page.locator('#status')).toContainText('Local fixtures: HTTP 500')
  await page.getByRole('button', { name: 'Try again' }).click()
  await expect(page.locator('#results li')).toHaveCount(1)
})

test('recently opened items can be removed, and the empty home page explains itself', async ({ page, app }) => {
  await page.goto(app.origin)
  await page.getByRole('button', { name: 'Remove Playback fixtures from this list' }).click()
  await expect(page.locator('#recent')).toContainText('Search every configured source')
  await expect(page.getByRole('link', { name: 'explore what BitMagnet has found' })).toHaveAttribute('href', '/explore')
  await page.reload()
  await expect(page.locator('#recent li')).toHaveCount(0)
})
