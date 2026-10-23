import path from 'node:path'
import { createServer } from 'vite'
import { test, expect } from './fixtures.js'
import { remux, expectPlaying } from './helpers.js'

test('Vite proxy accepts same-origin settings writes and StrictMode player disposal', async ({ browser, app }) => {
  const prefixes = ['/api', '/raw', '/tar', '/hls', '/subs', '/playlist.m3u', '/health']
  const vite = await createServer({ configFile: path.resolve('vite.config.js'), server: { host: '127.0.0.1', port: 0, proxy: Object.fromEntries(prefixes.map(prefix => [prefix, { target: app.origin }])) } })
  const context = await browser.newContext()
  try {
    await vite.listen()
    const origin = vite.resolvedUrls.local[0].replace(/\/$/, '')
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', e => errors.push(e.message))
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
    await page.route('**/*', route => [origin, app.origin].includes(new URL(route.request().url()).origin) ? route.continue() : route.abort('blockedbyclient'))
    await page.goto(`${origin}/settings`)
    await expect(page.locator('#setting-search-timeoutS')).toBeVisible()
    const response = await page.request.patch(`${origin}/api/settings`, { headers: { Origin: origin }, data: { 'search.timeoutS': 35 } })
    expect(response.status()).toBe(200)
    expect((await response.json()).values['search.timeoutS']).toBe(35)
    await page.goto(app.player(remux).replace(app.origin, origin))
    await expectPlaying(page)
    await page.locator('#back').click()
    await expect(page.locator('#name')).toHaveText('Playback fixtures')
    expect(errors).toEqual([])
    await page.goto(`${origin}/`)
  } finally { await context.close(); await vite.close() }
})
