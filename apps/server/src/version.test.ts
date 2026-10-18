import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { readAppVersion } from './version.ts'

test('the application version comes from the server manifest', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { name: string, version: string, private: boolean }
  assert.equal(manifest.name, '@magplay/server')
  assert.equal(manifest.private, true)
  assert.equal(readAppVersion(), manifest.version)
})
