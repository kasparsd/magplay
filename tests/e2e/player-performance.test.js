// The Performance disclosure: lanes fed by the status poll, with the Transcoder lane only for HLS modes.
import { test, expect } from './fixtures.js'
import { direct, openPlayer, remux } from './helpers.js'

const lanes = page => page.locator('#performance .lane-label span')

test('Performance shows swarm, transcoder and buffer lanes for HLS, and no transcoder for direct files', async ({ page, app }) => {
  await openPlayer(page, app, remux)
  const toggle = page.getByRole('button', { name: 'Performance' })
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  await expect(lanes(page)).toHaveText(['Swarm', 'Transcoder', 'Buffer'])
  await expect(page.locator('#performance .lane-plot svg path.ff')).not.toHaveCount(0)
  // The status poll now carries the ffmpeg fields the lanes read
  const status = await page.waitForResponse(r => r.url().includes('/status?') && r.url().includes('session=') && !r.url().includes('session=&'))
  const { session } = await status.json()
  expect(session).toHaveProperty('fps')
  expect(session).toHaveProperty('cpu')
  // Closing the disclosure stops the redraws
  await toggle.click()
  await expect(page.locator('#performance')).toBeHidden()

  await openPlayer(page, app, direct)
  await page.getByRole('button', { name: 'Performance' }).click()
  await expect(lanes(page)).toHaveText(['Swarm', 'Buffer'])
})
