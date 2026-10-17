import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'

const keys = ['MAX_HLS_SESSIONS', 'MAX_TORRENT_LOADS', 'MAX_PROBES', 'MAX_SUBTITLE_JOBS', 'HLS_MAX_GB', 'MIN_FREE_GB', 'TORRENT_CHECK_TIMEOUT_S']
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !keys.includes(key)))

test('resource settings reject zero, negative, non-finite and fractional job counts at startup', () => {
  for (const [key, value] of [['MAX_PROBES', '0'], ['MAX_HLS_SESSIONS', '-1'], ['MAX_SUBTITLE_JOBS', '1.5'], ['HLS_MAX_GB', 'Infinity'], ['MIN_FREE_GB', 'bad']]) {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', 'await import("./src/config.js")'], { env: { ...env, [key]: value }, encoding: 'utf8' })
    assert.notEqual(result.status, 0, key)
    assert.match(result.stderr, new RegExp(`${key} must be a positive`))
  }
})
