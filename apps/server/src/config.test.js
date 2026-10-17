import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const keys = ['MAX_HLS_SESSIONS', 'MAX_TORRENT_LOADS', 'MAX_PROBES', 'MAX_SUBTITLE_JOBS', 'HLS_MAX_GB', 'MIN_FREE_GB', 'TORRENT_CHECK_TIMEOUT_S']
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !keys.includes(key)))

test('resource settings reject zero, negative, non-finite and fractional job counts at startup', () => {
  for (const [key, value] of [['MAX_PROBES', '0'], ['MAX_HLS_SESSIONS', '-1'], ['MAX_SUBTITLE_JOBS', '1.5'], ['HLS_MAX_GB', 'Infinity'], ['MIN_FREE_GB', 'bad']]) {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', 'await import("./apps/server/src/config.js")'], { env: { ...env, [key]: value }, encoding: 'utf8' })
    assert.notEqual(result.status, 0, key)
    assert.match(result.stderr, new RegExp(`${key} must be a positive`))
  }
})

test('source secrets follow stable ids rather than source-list positions', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'magplay-settings-'))
  const settings = path.join(dir, 'settings.json')
  await writeFile(settings, JSON.stringify({
    sources: [
      { id: 'first', type: 'torznab', name: 'First', url: 'http://first.test/api', apiKey: 'first-key' },
      { id: 'second', type: 'torznab', name: 'Second', url: 'http://second.test/api', apiKey: 'second-key' },
    ]
  }))
  try {
    const script = `
      const { updateSettings, settingsSnapshot } = await import('./apps/server/src/config.js')
      await updateSettings({ sources: [{ id: 'second', type: 'torznab', name: 'Second', url: 'http://second.test/api', apiKey: '' }] })
      console.log(settingsSnapshot().values.sources[0].apiKey)
    `
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...Object.fromEntries(Object.entries(env).filter(([key]) => !/^(TORZNAB_|JACKETT_|PROWLARR_|SETTINGS_PATH)$/.test(key))), SETTINGS_PATH: settings }, encoding: 'utf8',
    })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout.trim(), 'second-key')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
