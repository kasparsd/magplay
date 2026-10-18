import { test, expect } from './fixtures.js'

test('pasted magnet opens its torrent with all discovery hints and returns to results', async ({ page, app }) => {
  const magnet = `magnet:?xt=urn:btih:${app.ih}&dn=Pasted+magnet&tr=udp%3A%2F%2F127.0.0.1%3A1`
  await page.goto(app.origin)
  await page.locator('#search input[name="q"]').fill(magnet)
  await page.locator('#search').getByRole('button', { name: 'Search' }).click()
  await expect(page.locator('#status')).toHaveText('1 result')
  const result = page.locator('#results').getByRole('link', { name: 'Pasted magnet', exact: true })
  const href = await result.getAttribute('href')
  const forwarded = new URL(href, app.origin).searchParams.get('magnet')
  expect(new URL(forwarded).searchParams.get('tr')).toBe('udp://127.0.0.1:1')
  const add = page.waitForRequest(req => req.url() === `${app.origin}/api/torrents` && req.method() === 'POST')
  await result.click()
  expect((await add).postDataJSON()).toEqual({ magnet: forwarded })
  await expect(page).toHaveURL(app.torrent)
  await expect(page.locator('#name')).toHaveText('Playback fixtures')
  await page.getByRole('link', { name: '← Results' }).click()
  await expect(result).toBeVisible()
  await page.reload()
  await expect(result).toBeVisible()
})

test('invalid pasted magnets show a useful error', async ({ page, app }) => {
  await page.goto(`${app.origin}/?${new URLSearchParams({ q: 'magnet:?xt=urn:btih:invalid' })}`)
  await expect(page.locator('#status')).toContainText('Enter a valid magnet link')
  await expect(page.locator('#results')).toBeHidden()
})
