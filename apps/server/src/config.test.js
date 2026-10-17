import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const keys = ['MAX_HLS_SESSIONS', 'MAX_TORRENT_LOADS', 'MAX_PROBES', 'MAX_SUBTITLE_JOBS', 'HLS_MAX_GB', 'MIN_FREE_GB', 'TORRENT_CHECK_TIMEOUT_S', 'PORT', 'CACHE_DIR']
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !keys.includes(key)))
const load = (extra, script = 'await import("./apps/server/src/config.js")') =>
  spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...env, ...extra }, encoding: 'utf8' })

test('invalid env values stop the server at startup, naming the variable', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'magplay-config-'))
  for (const [key, value, message] of [['MAX_PROBES', '0', 'at least 1'], ['MAX_HLS_SESSIONS', '-1', 'at least 1'], ['MAX_SUBTITLE_JOBS', '1.5', 'a whole number'], ['HLS_MAX_GB', 'Infinity', 'a number'], ['MIN_FREE_GB', 'bad', 'a number']]) {
    const result = load({ CACHE_DIR: dir, [key]: value })
    assert.notEqual(result.status, 0, key)
    assert.match(result.stderr, new RegExp(`${key} must be ${message}`))
  }
  fs.rmSync(dir, { recursive: true, force: true })
})

test('saved settings feed config, and env vars win over them', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'magplay-config-'))
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ 'cache.maxGb': 80, 'limits.probes': 3 }))
  const script = 'const { default: c } = await import("./apps/server/src/config.js"); console.log(JSON.stringify([c.cacheMaxBytes, c.maxProbes]))'
  const result = load({ CACHE_DIR: dir, MAX_PROBES: '5' }, script)
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout.trim().split('\n').at(-1)), [80 * 1024 ** 3, 5])
  fs.rmSync(dir, { recursive: true, force: true })
})
