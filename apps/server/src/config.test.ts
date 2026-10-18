import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { bitmagnetUrl, loadConfig, sourceConfigs, sourcesFromEnv } from './config.ts'

const tempDir = (t: { after: (fn: () => void) => void }): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'magplay-config-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('invalid env values stop the server at startup, naming the variable', t => {
  const dir = tempDir(t)
  for (const [key, value, message] of [['MAX_PROBES', '0', 'at least 1'], ['MAX_HLS_SESSIONS', '-1', 'at least 1'], ['MAX_SUBTITLE_JOBS', '1.5', 'a whole number'], ['HLS_MAX_GB', 'Infinity', 'a number'], ['MIN_FREE_GB', 'bad', 'a number']] as const) {
    assert.throws(() => loadConfig({ CACHE_DIR: dir, [key]: value }), new RegExp(`${key} must be ${message}`))
  }
})

test('saved settings feed config, and env vars win over them', t => {
  const dir = tempDir(t)
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ 'cache.maxGb': 80, 'limits.probes': 3 }))
  const { current } = loadConfig({ CACHE_DIR: dir, MAX_PROBES: '5' })
  assert.deepEqual([current().cacheMaxBytes, current().maxProbes], [80 * 1024 ** 3, 5])
})

test('saved live settings change current(); restart-only ones keep their startup value', t => {
  const app = loadConfig({ CACHE_DIR: tempDir(t) })
  const seen: string[][] = []
  app.onChange((config, changed) => seen.push([...changed, String(config.maxProbes)]))
  app.settings.update({ 'limits.probes': 4, 'server.port': 9999 })
  assert.equal(app.current().maxProbes, 4)
  assert.equal(app.current().port, 8080)
  assert.deepEqual(seen, [['limits.probes', 'server.port', '4']])
})

test('starts without sources when nothing is configured', () => {
  assert.deepEqual(sourcesFromEnv({}), [])
})

test('reads numbered Torznab feeds, Jackett and Prowlarr presets', () => {
  const configs = sourcesFromEnv({
    TORZNAB_URL: 'http://bitmagnet:3333/torznab/api',
    TORZNAB_URL_2: 'http://hydra:5076/torznab/api',
    TORZNAB_APIKEY_2: 'h',
    TORZNAB_NAME_2: 'NZBHydra2',
    JACKETT_URL: 'http://jackett:9117',
    JACKETT_APIKEY: 'j',
    JACKETT_INDEXER: 'tag:tv,!type:private',
    PROWLARR_URL: 'http://prowlarr:9696',
    PROWLARR_APIKEY: 'p',
    PROWLARR_INDEXERS: '3, 7',
  })
  assert.deepEqual(configs.map(c => [c.type, c.name]), [
    ['torznab', 'bitmagnet'], ['torznab', 'NZBHydra2'], ['jackett', 'Jackett'], ['prowlarr', 'Prowlarr'],
  ])
  assert.equal(configs[1]?.apiKey, 'h')
  assert.deepEqual(configs[2], { type: 'jackett', name: 'Jackett', url: 'http://jackett:9117', apiKey: 'j', indexer: 'tag:tv,!type:private' })
  assert.deepEqual(configs[3]?.type === 'prowlarr' && configs[3].indexerIds, ['3', '7'])
})

test('settings items become source configs with default names and indexers', () => {
  assert.deepEqual(sourceConfigs([
    { id: 'a', type: 'torznab', name: '', url: 'http://bitmagnet:3333/torznab/api', apiKey: '' },
    { id: 'b', type: 'prowlarr', url: 'http://prowlarr:9696', apiKey: 'k', indexer: '' },
  ]), [
    { id: 'a', type: 'torznab', name: 'bitmagnet', url: 'http://bitmagnet:3333/torznab/api', apiKey: '' },
    { id: 'b', type: 'prowlarr', name: 'Prowlarr', url: 'http://prowlarr:9696', apiKey: 'k', indexerIds: ['-2'] },
  ])
})

test('unknown source types and bad URLs fail at startup', () => {
  assert.throws(() => sourceConfigs([{ id: 'x', type: 'unknown', name: 'x', url: 'http://x' }]), /Unknown source type: unknown/)
  assert.throws(() => sourcesFromEnv({ TORZNAB_URL: 'bitmagnet:3333' }), /Not an http\(s\) URL/)
  assert.throws(() => sourcesFromEnv({ PROWLARR_URL: 'prowlarr' }), /Not an http\(s\) URL/)
})

test('finds BitMagnet for Explore', () => {
  assert.equal(bitmagnetUrl('', sourcesFromEnv({})), null)
  assert.equal(bitmagnetUrl('http://10.0.0.5:3333/torznab/api', []), 'http://10.0.0.5:3333')
  assert.equal(bitmagnetUrl('', sourcesFromEnv({ TORZNAB_URL: 'http://bitmagnet:3333/torznab/api' })), 'http://bitmagnet:3333')
  // Jackett's feed also ends in /torznab/api, but not at the root
  assert.equal(bitmagnetUrl('', sourcesFromEnv({ JACKETT_URL: 'http://jackett:9117', TORZNAB_URL: 'http://hydra:5076/api' })), null)
})
