import { test, expect } from './fixtures.js'

test('status indicator, direct Settings button and Settings layout stay usable', async ({ page, app }, testInfo) => {
  await page.goto(app.origin)
  await expect(page.locator('.status-pin')).toHaveClass(/warn/)
  await expect(page.locator('.topbar .status-menu')).toHaveCount(1)
  await expect(page.locator('.topbar .settings-shortcut')).toHaveCount(1)
  await expect(page.locator('.status-count')).toHaveText('1')

  await page.locator('.status-pin').click()
  await expect(page.locator('.status-panel')).toBeVisible()
  const ffmpegLabel = page.locator('.status-check').filter({ hasText: 'ffmpeg' }).locator('.check-label')
  await expect(ffmpegLabel).toBeVisible()
  await expect(ffmpegLabel).toHaveText('ffmpeg')
  const statusShot = testInfo.outputPath('status-menu.png')
  await page.screenshot({ path: statusShot })
  await testInfo.attach('status-menu', { path: statusShot, contentType: 'image/png' })

  await page.locator('.settings-shortcut').click()
  await expect(page).toHaveURL(`${app.origin}/settings`)
  await expect(page.locator('.source-editor').first().locator('input').first()).toBeDisabled()
  await page.locator('.source-editor').first().getByRole('button', { name: 'Test' }).click()
  await expect(page.locator('.source-editor').first().locator('.source-test-status')).toHaveText('Connected')

  const timeout = page.locator('#setting-searchTimeoutS')
  await timeout.fill('31')
  await timeout.evaluate(input => input.dispatchEvent(new Event('change', { bubbles: true })))
  await expect(timeout).toBeFocused()
  await expect(page.locator('#save-bar')).toBeVisible()
  const saved = page.waitForResponse(response => response.url().endsWith('/api/settings') && response.request().method() === 'PATCH')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  expect((await saved).ok()).toBeTruthy()
  await expect(page.locator('#save-bar')).toBeHidden()
  await page.reload()
  await expect(timeout).toHaveValue('31')

  await expect(page.locator('#settings-nav')).toHaveCount(0)
  const debug = page.locator('.settings-section').filter({ has: page.getByRole('heading', { name: 'Debug', exact: true }) })
  expect(await debug.evaluate(section =>
    [...section.childNodes].some(node => node.nodeType === Node.TEXT_NODE && node.textContent?.trim() === '0'))).toBeFalsy()
  await debug.scrollIntoViewIfNeeded()
  const debugShot = testInfo.outputPath('settings-debug.png')
  await page.screenshot({ path: debugShot })
  await testInfo.attach('settings-debug', { path: debugShot, contentType: 'image/png' })

  const crossOrigin = await page.request.patch(`${app.origin}/api/settings`, {
    headers: { Origin: 'https://example.invalid' },
    data: { patch: { searchTimeoutS: 20 } },
  })
  expect(crossOrigin.status()).toBe(403)
  const nullOrigin = await page.request.patch(`${app.origin}/api/settings`, {
    headers: { Origin: 'null' },
    data: { patch: { searchTimeoutS: 20 } },
  })
  expect(nullOrigin.status()).toBe(403)
})
