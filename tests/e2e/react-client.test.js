import fs from 'node:fs/promises'
import path from 'node:path'
import { test, expect } from './fixtures.js'
import { direct, expectPlaying, showChrome } from './helpers.js'

test('search, torrent and the lazy player share one document and dispose playback on return', async ({ page, app }, testInfo) => {
  const scripts = []
  page.on('request', request => { if (request.resourceType() === 'script') scripts.push(new URL(request.url()).pathname) })
  await page.goto(`${app.origin}/?q=Playback`)
  await expect(page.locator('#results li')).toHaveCount(1)
  expect(scripts.some(name => /Player-|hls/.test(name))).toBe(false)
  await page.evaluate(() => { window.reactDocument = 'retained' })
  await page.locator('#results .title').click()
  await expect(page.locator('#name')).toHaveText('Playback fixtures')
  expect(await page.evaluate(() => window.reactDocument)).toBe('retained')
  await page.locator('.files .label').first().click()
  await expectPlaying(page)
  expect(scripts.some(name => /Player-/.test(name))).toBe(true)
  expect(await page.evaluate(() => window.reactDocument)).toBe('retained')
  await page.locator('#back').click()
  await expect(page.locator('#name')).toHaveText('Playback fixtures')
  await page.getByRole('link', { name: 'S01E02', exact: true }).click()
  await expectPlaying(page)
  await showChrome(page)
  await page.screenshot({ path: testInfo.outputPath('react-player-desktop.png') })
  await page.setViewportSize({ width: 375, height: 812 })
  await page.screenshot({ path: testInfo.outputPath('react-player-phone.png') })
  await page.locator('#back').click()
  await expect(page.locator('#name')).toHaveText('Playback fixtures')
  await expect.poll(async () => (await fs.readdir(path.join(app.cache, 'hls'))).length).toBe(0)
  expect(await page.evaluate(() => window.reactDocument)).toBe('retained')
})

test('next episode disposes its controller without replacing the document', async ({ page, app }) => {
  await page.goto(app.player(direct))
  await expectPlaying(page)
  await page.evaluate(() => { window.reactDocument = 'retained' })
  await showChrome(page)
  const next = page.locator('#next')
  const href = await next.getAttribute('href')
  await next.click()
  await expect(page).toHaveURL(app.origin + href)
  await expectPlaying(page)
  expect(await page.evaluate(() => window.reactDocument)).toBe('retained')
  await page.locator('#back').click()
  await expect(page.locator('#name')).toBeVisible()
  await expect.poll(async () => (await fs.readdir(path.join(app.cache, 'hls'))).length).toBe(0)
})

test('malformed torrent and player route parameters never start playback', async ({ page, app }) => {
  let plays = 0
  page.on('request', request => { if (request.url().endsWith('/api/play')) plays++ })
  for (const url of ['/t/not-a-hash', `/play/${app.ih}/-1`, `/play/${app.ih}/1.5`, `/play/${app.ih}/9007199254740992`, '/play/not-a-hash/0']) {
    await page.goto(app.origin + url)
    await expect(page.getByRole('heading', { name: 'Not found' })).toBeVisible()
  }
  expect(plays).toBe(0)
})

test('unsaved settings block in-app navigation without losing the draft', async ({ page, app }) => {
  await page.goto(`${app.origin}/settings`)
  await page.evaluate(() => { window.reactDocument = 'retained' })
  await page.locator('#setting-search-timeoutS').fill('45')
  page.once('dialog', dialog => dialog.dismiss())
  await page.locator('.brand').click()
  await expect(page).toHaveURL(`${app.origin}/settings`)
  await expect(page.locator('#setting-search-timeoutS')).toHaveValue('45')
  page.once('dialog', dialog => dialog.accept())
  await page.locator('.brand').click()
  await expect(page).toHaveURL(app.origin + '/')
  expect(await page.evaluate(() => window.reactDocument)).toBe('retained')
})

test('a failed lazy Player chunk offers a reload that restores playback', async ({ page, app }) => {
  const pattern = '**/assets/Player-*.js'
  await page.route(pattern, route => route.abort('failed'))
  await page.goto(app.player(direct))
  await expect(page.getByRole('heading', { name: 'Page unavailable' })).toBeVisible()
  await page.unroute(pattern)
  await page.getByRole('button', { name: 'Reload app', exact: true }).click()
  await expectPlaying(page)
})

test('a source test result cannot describe an endpoint edited while the test ran', async ({ page, app }) => {
  let finish
  const result = new Promise(resolve => { finish = resolve })
  let started = false
  await page.route('**/api/settings/test', async route => {
    started = true
    await result
    await route.fulfill({ json: { id: 'fixture', label: 'Source', required: true, level: 'ok', value: 'Old endpoint' } })
  })
  await page.goto(`${app.origin}/settings`)
  await page.getByRole('button', { name: '+ Add source' }).click()
  const source = page.locator('.list-item').last()
  const url = source.getByLabel('Source URL, source 2', { exact: true })
  await url.fill('http://old.local/feed')
  await source.getByRole('button', { name: 'Test old.local' }).click()
  await expect.poll(() => started).toBe(true)
  await url.fill('http://new.local/feed')
  finish()
  await expect(source.getByRole('button', { name: 'Test new.local' })).toBeEnabled()
  await expect(source.locator('.source-status')).toBeEmpty()
  await expect(source).not.toContainText('Old endpoint')
  await page.locator('#savebar-discard').click()
})

test('saving discovery settings clears cached results whose private link ids expired', async ({ page, app }) => {
  let searches = 0
  const torrent = await (await page.request.get(`${app.origin}/api/torrents/${app.ih}`)).json()
  await page.route('**/api/search?*', async route => {
    searches++
    return route.fulfill({ json: { sources: [], results: [{ title: 'Private release', infoHash: null, magnet: null, linkId: `private-${searches}`, sources: [], badges: [], size: null, seeders: null, warning: null, playbackEffort: null }] } })
  })
  await page.route('**/api/torrents', route => route.request().postDataJSON().linkId === 'private-2'
    ? route.fulfill({ json: torrent })
    : route.fulfill({ status: 410, json: { error: 'This search result has expired. Search again.' } }))
  await page.goto(`${app.origin}/?q=Playback`)
  await expect(page.locator('#results li')).toHaveCount(1)
  await page.getByRole('link', { name: 'Settings', exact: true }).click()
  await page.locator('#setting-search-timeoutS').fill('35')
  await page.locator('#savebar-save').click()
  await expect(page.locator('#savebar-count')).toHaveText('Saved: search timeout')
  await page.locator('.topsearch input').fill('Playback')
  await page.locator('.topsearch input').press('Enter')
  await expect.poll(() => searches).toBe(2)
  await page.locator('#results .title').click()
  await expect(page.locator('#name')).toHaveText('Playback fixtures')
})
