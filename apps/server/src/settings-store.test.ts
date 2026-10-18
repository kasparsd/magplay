import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createSettingsStore, mask, resolve } from './settings-store.ts'
import type { ListItem } from '@magplay/api-contract'

const tempFile = (t: { after: (fn: () => void) => void }): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'magplay-settings-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return path.join(dir, 'settings.json')
}

test('env wins over the file, the file over the default, and each value says where it came from', () => {
  const r = resolve({ CACHE_MAX_GB: '20' }, { 'cache.maxGb': 80, 'limits.probes': 3 })
  assert.equal(r.values['cache.maxGb'], 20)
  assert.deepEqual(r.meta['cache.maxGb'], { source: 'env', env: 'CACHE_MAX_GB' })
  assert.equal(r.values['limits.probes'], 3)
  assert.deepEqual(r.meta['limits.probes'], { source: 'file' })
  assert.equal(r.values['limits.hlsSessions'], 2)
  assert.deepEqual(r.meta['limits.hlsSessions'], { source: 'default' })
})

test('an invalid env value throws with the variable name; an invalid saved value falls back with a warning', (t) => {
  assert.throws(() => resolve({ MAX_PROBES: '0' }, {}), /MAX_PROBES must be at least 1/)
  assert.throws(() => resolve({ ALLOW_VIDEO_TRANSCODE: 'maybe' }, {}), /ALLOW_VIDEO_TRANSCODE must be on or off/)
  t.mock.method(console, 'warn', () => {})
  assert.equal(resolve({}, { 'limits.probes': -4 }).values['limits.probes'], 2)
})

test('env strings parse like the browser’s values: numbers, toggles and choices', () => {
  const r = resolve({ ALLOW_VIDEO_TRANSCODE: 'yes', TRANSCODE_MAX_HEIGHT: '1080', DHT_ENABLED: 'off' }, {})
  assert.equal(r.values['transcode.allow'], true)
  assert.equal(r.values['transcode.maxHeight'], 1080)
  assert.equal(r.values['torrents.dht'], false)
})

test('list env items are locked and listed before the saved ones', () => {
  const readers = { sources: () => [{ id: 'env-0', type: 'torznab', url: 'http://bitmagnet:3333/torznab/api', apiKey: '' }] }
  const own = [{ id: 'a', type: 'prowlarr', url: 'http://prowlarr:9696', apiKey: 'k' }]
  const r = resolve({ TORZNAB_URL: 'x' }, { sources: own }, readers)
  assert.deepEqual((r.values.sources as ListItem[]).map(i => i.id), ['a'])
  assert.deepEqual(r.meta.sources?.locked?.map(i => i.id), ['env-0'])
  assert.deepEqual((r.effective.sources as ListItem[]).map(i => i.id), ['env-0', 'a'])
  // Without env or file, list defaults are editable values
  assert.equal((resolve({}, {}).values['torrents.trackers'] as ListItem[]).length, 5)
})

test('secrets never leave masked: { set } only', () => {
  const r = resolve({}, { sources: [{ id: 'a', type: 'prowlarr', url: 'http://prowlarr:9696', apiKey: 'hunter2' }] })
  const masked = mask(r)
  assert.deepEqual((masked.values.sources as ListItem[])[0]?.apiKey, { set: true })
  assert.ok(!JSON.stringify(masked).includes('hunter2'))
})

test('updates validate the whole patch, save atomically, keep unchanged secrets and report changes', (t) => {
  const file = tempFile(t)
  const store = createSettingsStore({ file, env: { MAX_PROBES: '3' } })
  const changes: string[][] = []
  store.on('changed', keys => changes.push(keys))

  // Nothing is half-applied: one bad field rejects the patch
  const bad = store.update({ 'cache.maxGb': 90, 'limits.hlsSessions': 0, 'limits.probes': 4 })
  assert.equal(bad.ok, false)
  assert.deepEqual(Object.keys(bad.ok ? {} : bad.fields).sort(), ['limits.hlsSessions', 'limits.probes'])
  assert.equal(fs.existsSync(file), false)

  assert.deepEqual(store.update({ 'cache.maxGb': 90, sources: [{ type: 'prowlarr', url: 'http://prowlarr:9696', apiKey: 'secret' }] }), { ok: true, changed: ['sources', 'cache.maxGb'] })
  assert.deepEqual(changes, [['sources', 'cache.maxGb']])
  const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
  assert.equal(saved['cache.maxGb'], 90)
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['settings.json'])

  // The browser sends back { set: true } for a key it didn't replace
  const [item] = store.response().values.sources as ListItem[]
  assert.ok(item)
  store.update({ sources: [{ ...item, name: 'NAS Prowlarr' }] })
  assert.equal((store.effective.sources as ListItem[])[0]?.apiKey, 'secret')
  assert.equal((store.effective.sources as ListItem[])[0]?.name, 'NAS Prowlarr')
  const tested = store.unsavedItem('sources', { ...item, url: 'http://other:9696' })
  assert.ok(tested.ok && tested.item.apiKey === 'secret' && tested.item.url === 'http://other:9696')

  // A reload reads the file back
  assert.equal(createSettingsStore({ file, env: {} }).effective['cache.maxGb'], 90)
})

test('restart-only settings are flagged until the value in use matches again', (t) => {
  const store = createSettingsStore({ file: tempFile(t), env: {} })
  store.update({ 'server.port': 8090 })
  assert.deepEqual(store.pendingRestart(), ['server.port'])
  assert.equal(store.response().meta['server.port']?.pendingRestart, true)
  store.update({ 'server.port': 8080 })
  assert.deepEqual(store.pendingRestart(), [])
})
