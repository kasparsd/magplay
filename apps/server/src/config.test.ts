import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { bitmagnetUrl, loadConfig, sourceConfigs, sourcesFromEnv, trackersFromEnv } from './config.ts'

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
  for (const [key, value] of [['PORT', '70000'], ['TORRENT_PORT', '-1'], ['METADATA_TIMEOUT_S', '99999'], ['TORRENT_CHECK_TIMEOUT_S', '0'], ['IDLE_TORRENT_MIN', '1000000']] as const) {
    assert.throws(() => loadConfig({ CACHE_DIR: dir, [key]: value }), new RegExp(key))
  }
  assert.throws(() => loadConfig({ CACHE_DIR: dir, EXTRA_TRACKERS: 'udp://ok:1/announce, not a url' }), /EXTRA_TRACKERS: "not a url"/)
})

test('EXTRA_TRACKERS: unset means the defaults, empty means none, and each entry must be a tracker URL', () => {
  assert.ok(trackersFromEnv(undefined).length > 0)
  assert.deepEqual(trackersFromEnv(''), [])
  assert.deepEqual(trackersFromEnv('udp://a:1/announce, wss://b/announce'), ['udp://a:1/announce', 'wss://b/announce'])
  assert.throws(() => trackersFromEnv('magnet:?xt=1'), /EXTRA_TRACKERS/)
})

test('saved settings feed config, and env vars win over them', t => {
  const dir = tempDir(t)
  // limits.probes isn't a page setting, so a saved value is ignored and the env var (or default) sets it
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ 'cache.maxGb': 80, 'cache.hlsMaxGb': 4, 'limits.probes': 3 }))
  const { current } = loadConfig({ CACHE_DIR: dir, MAX_PROBES: '5', HLS_MAX_GB: '6' })
  assert.deepEqual([current().cacheMaxBytes, current().hlsMaxBytes, current().maxProbes], [80 * 1024 ** 3, 6 * 1024 ** 3, 5])
  assert.equal(loadConfig({ CACHE_DIR: dir }).current().maxProbes, 2)
})

test('saved settings change current() at once; env-only knobs aren’t settings', t => {
  const app = loadConfig({ CACHE_DIR: tempDir(t), PORT: '9000' })
  const seen: string[][] = []
  app.onChange((config, changed) => seen.push([...changed, String(config.searchTimeoutMs)]))
  assert.equal(app.settings.update({ 'search.timeoutS': 45 }).ok, true)
  assert.equal(app.current().searchTimeoutMs, 45_000)
  assert.deepEqual(seen, [['search.timeoutS', '45000']])
  assert.equal(app.current().port, 9000)
  assert.equal(app.settings.update({ 'server.port': 9999 }).ok, false)
  assert.deepEqual(app.current().extraTrackers.length, 5)
  assert.deepEqual(loadConfig({ CACHE_DIR: tempDir(t), EXTRA_TRACKERS: '' }).current().extraTrackers, [])
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
