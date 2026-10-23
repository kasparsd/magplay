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
  const r = resolve({ CACHE_MAX_GB: '20' }, { 'cache.maxGb': 80, 'search.timeoutS': 45 })
  assert.equal(r.values['cache.maxGb'], 20)
  assert.deepEqual(r.meta['cache.maxGb'], { source: 'env', env: 'CACHE_MAX_GB' })
  assert.equal(r.values['search.timeoutS'], 45)
  assert.deepEqual(r.meta['search.timeoutS'], { source: 'file' })
  assert.equal(r.values['cache.hlsMaxGb'], 8)
  assert.deepEqual(r.meta['cache.hlsMaxGb'], { source: 'default' })
})

test('an invalid env value throws with the variable name; an invalid saved value falls back with a warning', (t) => {
  assert.throws(() => resolve({ SEARCH_TIMEOUT_S: '0' }, {}), /SEARCH_TIMEOUT_S must be at least 1/)
  assert.throws(() => resolve({ ALLOW_VIDEO_TRANSCODE: 'maybe' }, {}), /ALLOW_VIDEO_TRANSCODE must be on or off/)
  t.mock.method(console, 'warn', () => {})
  assert.equal(resolve({}, { 'search.timeoutS': -4 }).values['search.timeoutS'], 30)
})

test('env strings parse like the browser’s values: numbers, toggles and choices', () => {
  const r = resolve({ ALLOW_VIDEO_TRANSCODE: 'yes', TRANSCODE_MAX_HEIGHT: '1080', MIN_FREE_GB: '0.5' }, {})
  assert.equal(r.values['transcode.allow'], true)
  assert.equal(r.values['transcode.maxHeight'], 1080)
  assert.equal(r.values['cache.minFreeGb'], 0.5)
})

test('list env items are locked and listed before the saved ones', () => {
  const readers = { sources: () => [{ id: 'env-0', type: 'torznab', url: 'http://bitmagnet:3333/torznab/api', apiKey: '' }] }
  const own = [{ id: 'a', type: 'prowlarr', url: 'http://prowlarr:9696', apiKey: 'k' }]
  const r = resolve({ TORZNAB_URL: 'x' }, { sources: own }, readers)
  assert.deepEqual((r.values.sources as ListItem[]).map(i => i.id), ['a'])
  assert.deepEqual(r.meta.sources?.locked?.map(i => i.id), ['env-0'])
  assert.deepEqual((r.effective.sources as ListItem[]).map(i => i.id), ['env-0', 'a'])
})

test('secrets never leave masked: { set } only', () => {
  const r = resolve({}, { sources: [{ id: 'a', type: 'prowlarr', url: 'http://prowlarr:9696', apiKey: 'hunter2' }] })
  const masked = mask(r)
  assert.deepEqual((masked.values.sources as ListItem[])[0]?.apiKey, { set: true })
  assert.ok(!JSON.stringify(masked).includes('hunter2'))
})

test('updates validate the whole patch, save atomically, keep unchanged secrets and report changes', (t) => {
  const file = tempFile(t)
  const store = createSettingsStore({ file, env: { SEARCH_TIMEOUT_S: '20' } })
  const changes: string[][] = []
  store.on('changed', keys => changes.push(keys))

  // Nothing is half-applied: one bad field rejects the patch
  const bad = store.update({ 'cache.maxGb': 90, 'cache.hlsMaxGb': 0, 'search.timeoutS': 40 })
  assert.equal(bad.ok, false)
  assert.deepEqual(Object.keys(bad.ok ? {} : bad.fields).sort(), ['cache.hlsMaxGb', 'search.timeoutS'])
  assert.equal(fs.existsSync(file), false)

  assert.deepEqual(store.update({ 'cache.maxGb': 90, sources: [{ type: 'prowlarr', url: 'http://prowlarr:9696', apiKey: 'secret' }] }), { ok: true, changed: ['sources', 'cache.maxGb'] })
  assert.deepEqual(changes, [['sources', 'cache.maxGb']])
  const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
  assert.equal(saved['cache.maxGb'], 90)
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['settings.json'])

  // The browser sends back { set: true } for a key it didn't replace
  const [item] = store.response().values.sources as ListItem[]
  assert.ok(item)
  store.update({ sources: [{ ...item }] })
  assert.equal((store.effective.sources as ListItem[])[0]?.apiKey, 'secret')
  const tested = store.unsavedItem('sources', { ...item, url: 'http://other:9696' })
  assert.ok(tested.ok && tested.item.apiKey === 'secret' && tested.item.url === 'http://other:9696')

  // A reload reads the file back
  assert.equal(createSettingsStore({ file, env: {} }).effective['cache.maxGb'], 90)
})

test('env-only knobs resolve with the same validation, outside the page’s schema', () => {
  const defs = [{ key: 'port', env: ['PORT'], type: 'number', default: 8080, min: 1, max: 65535, integer: true, section: 'debug', scope: 'server', label: 'Port' }] satisfies Parameters<typeof resolve>[3]
  assert.equal(resolve({}, {}, {}, defs).effective.port, 8080)
  assert.equal(resolve({ PORT: '9000' }, {}, {}, defs).effective.port, 9000)
  assert.throws(() => resolve({ PORT: '0' }, {}, {}, defs), /PORT must be at least 1/)
})
