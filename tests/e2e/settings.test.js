import { test, expect } from './fixtures.js'

const statusButton = page => page.locator('.status-button')

async function save (page) {
  await expect(page.locator('#savebar')).toBeVisible()
  const response = page.waitForResponse(r => r.url().endsWith('/api/settings') && r.request().method() === 'PATCH')
  await page.locator('#savebar-save').click()
  expect((await response).status()).toBe(200)
  await expect(page.locator('#savebar-count')).toHaveText(/^Saved: /)
  await expect(page.locator('#savebar')).toBeHidden({ timeout: 8000 })
}

test('the top bar has a status button with a panel of checks, and a gear that links to Settings', async ({ page, app }) => {
  await page.goto(app.origin)
  await expect(statusButton(page)).toHaveAttribute('aria-label', /^Status: (all good|not checked yet|checking|\d+ problems?)$/)
  const gear = page.locator('header.topbar').getByRole('link', { name: 'Settings', exact: true })
  await expect(gear).toHaveAttribute('href', '/settings')
  for (const control of [statusButton(page), gear]) {
    const box = await control.boundingBox()
    expect(box.width).toBeGreaterThanOrEqual(40)
    expect(box.height).toBeGreaterThanOrEqual(40)
  }
  await statusButton(page).click()
  const panel = page.locator('.status-panel')
  await expect(panel.locator('.status-check', { hasText: 'ffmpeg' })).toHaveClass(/lvl-ok/)
  await expect(panel.locator('.status-check', { hasText: 'Disk' })).toHaveClass(/lvl-ok/)
  // The fixture indexer answers the caps request, so its source is healthy
  await expect(panel.locator('.status-check', { hasText: '127' })).toHaveClass(/lvl-ok/)
  // Problems and fixes only: no history of past changes, and Settings is the gear's job
  await expect(panel.getByText('Recent')).toHaveCount(0)
  await expect(panel.getByRole('link', { name: 'Settings', exact: true })).toHaveCount(0)
  await expect(panel.getByRole('link', { name: 'Debug details' })).toHaveAttribute('href', '/settings#debug')
  await page.keyboard.press('Escape')
  await expect(panel).toBeHidden()
  await gear.click()
  await expect(page).toHaveURL(`${app.origin}/settings`)
  await expect(gear).toHaveAttribute('aria-current', 'page')
})

test('a broken source turns the dot red and its action deep-links to Sources', async ({ page, app }) => {
  await page.goto(`${app.origin}/settings#sources`)
  await expect(page.locator('#sources')).toBeVisible()
  // The env source is listed first and read-only
  await expect(page.locator('#setting-sources-0-url')).toBeDisabled()
  await page.getByRole('button', { name: '+ Add source' }).click()
  await page.locator('#setting-sources-1-url').fill('http://127.0.0.1:9/torznab/api')
  await page.locator('#savebar-save').click()
  await expect(page.locator('#savebar-count')).toHaveText('Saved: sources')

  await statusButton(page).click()
  await expect(statusButton(page).locator('.status-dot')).toHaveClass(/lvl-error/)
  const failing = page.locator('.status-check.lvl-error')
  await expect(failing).toContainText(/can.t reach/i)
  await expect(failing.getByRole('link')).toHaveAttribute('href', '/settings#sources')
  await expect(page.locator('#sources-title .status-dot')).toHaveClass(/lvl-error/)

  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Remove source 2' }).click()
  await save(page)
  await statusButton(page).click()
  await expect(statusButton(page).locator('.status-dot')).not.toHaveClass(/lvl-error/)
})

test('a live setting applies without a restart, and env-set values are read-only', async ({ page, app }) => {
  await page.goto(`${app.origin}/settings#sources`)
  const timeout = page.locator('#setting-search-timeoutS')
  await timeout.fill('45')
  await expect(page.locator('#savebar-count')).toHaveText('1 unsaved change')
  await save(page)
  const settings = await (await page.request.get(`${app.origin}/api/settings`)).json()
  expect(settings.values['search.timeoutS']).toBe(45)
  expect(settings.meta['search.timeoutS']).toEqual({ source: 'file' })
  // Search was rebuilt with the new timeout and still works
  expect((await page.request.get(`${app.origin}/api/search?q=Playback`)).ok()).toBeTruthy()

  // Invalid values show inline and nothing is saved
  await timeout.fill('0')
  await timeout.blur()
  await expect(page.locator('#row-setting-search-timeoutS .field-error')).toContainText('at least 1')
  await page.locator('#savebar-save').click()
  await expect(page.locator('#savebar-status')).toHaveText(/aren’t valid/)
  await timeout.fill('30')
  await save(page)

  await page.goto(`${app.origin}/settings#server`)
  await expect(page.locator('#setting-torrents-port')).toBeDisabled()
  await expect(page.locator('#row-setting-torrents-port')).toContainText('TORRENT_PORT')
  const locked = await page.request.patch(`${app.origin}/api/settings`, { headers: { Origin: app.origin }, data: { 'torrents.port': 7000 } })
  expect(locked.status()).toBe(400)
  expect((await locked.json()).fields['torrents.port']).toMatch(/TORRENT_PORT/)
})

test('writes from another site are refused', async ({ page, app }) => {
  for (const [method, url] of [['patch', '/api/settings'], ['post', '/api/settings/test'], ['post', '/api/debug/clear-hls']]) {
    const res = await page.request[method](`${app.origin}${url}`, { headers: { Origin: 'http://evil.example' }, data: { 'cache.maxGb': 1 } })
    expect(res.status(), url).toBe(403)
  }
  const settings = await (await page.request.get(`${app.origin}/api/settings`)).json()
  expect(settings.values['cache.maxGb']).toBe(50)
})

test('the connection test runs, and a slow result warns on every page', async ({ page, app }) => {
  await page.goto(`${app.origin}/settings#connection`)
  await expect(page.locator('#connection')).toContainText('Not tested in this browser yet')
  await page.getByRole('button', { name: 'Test now' }).click()
  await expect(page.locator('#setting-connection-result')).toContainText('download', { timeout: 20_000 })

  await page.evaluate(() => localStorage.setItem('magplay:connection', JSON.stringify({ at: Date.now(), downBytesPerSec: 2e6, latencyMs: 20 })))
  await page.goto(`${app.origin}/explore`)
  await statusButton(page).click()
  const check = page.locator('.status-check', { hasText: 'Your connection' })
  await expect(check).toHaveClass(/lvl-warn/)
  await expect(check).toContainText('2.0 MB/s · 20 ms')
  await expect(check.getByRole('link', { name: /Test again/ })).toHaveAttribute('href', '/settings#connection')
})

test('browser preferences save at once, under the keys the Player reads', async ({ page, app }) => {
  await page.goto(app.origin)
  // As the Player remembers them: the file's language code
  await page.evaluate(() => localStorage.setItem('magplay:player:audioLanguage', '"lav"'))
  await page.goto(`${app.origin}/settings#playback`)
  await expect(page.locator('#setting-player-audioLanguage')).toHaveValue('lav')
  await page.locator('#setting-player-speed').getByText('1.25×').click()
  await page.locator('#setting-player-subtitleLanguage').selectOption('en')
  await page.locator('#setting-player-autoplayNext').click()
  await expect(page.locator('#savebar')).toBeHidden()
  const stored = await page.evaluate(() => ['speed', 'subtitleLanguage', 'autoplayNext'].map(k => localStorage.getItem(`magplay:player:${k}`)))
  expect(stored).toEqual(['1.25', '"en"', 'false'])
})

test('Settings is one page with every section stacked in order, and #section links scroll to it', async ({ page, app }) => {
  await page.goto(`${app.origin}/settings#debug`)
  const sections = page.locator('main.settings > #settings-body > section.settings-section')
  await expect(sections).toHaveCount(5)
  expect(await sections.evaluateAll(list => list.map(s => s.id))).toEqual(['sources', 'playback', 'connection', 'server', 'debug'])
  for (const id of ['sources', 'playback', 'connection', 'server', 'debug']) await expect(page.locator(`#${id}`)).toBeVisible()
  await expect(page.getByRole('heading', { level: 2, name: 'Debug' })).toBeInViewport()
  await expect(page.getByRole('heading', { level: 2, name: 'Sources' })).not.toBeInViewport()
  // A fix link from the status panel, on the same page, scrolls without leaving it
  await page.evaluate(() => { location.hash = 'sources' })
  await expect(page.getByRole('heading', { level: 2, name: 'Sources' })).toBeInViewport()
})
