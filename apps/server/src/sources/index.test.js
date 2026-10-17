import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bitmagnetUrl, sourcesFromEnv, createSources, sourceHealthRequest } from './index.js'
import { resolveLink } from './links.js'
import { mockFetch } from './test-helpers.js'

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
  assert.equal(configs[1].apiKey, 'h')
  assert.equal(configs[2].indexer, 'tag:tv,!type:private')
  assert.deepEqual(configs[3].indexerIds, ['3', '7'])
})

test('Jackett preset builds the feed URL, or keeps a full one', async () => {
  const fetch = mockFetch(() => ({ body: '<rss><channel></channel></rss>' }))
  const [filtered, full] = createSources([
    { type: 'jackett', name: 'J', url: 'http://jackett:9117/', apiKey: 'j', indexer: 'tag:tv,!type:private' },
    { type: 'jackett', name: 'J2', url: 'http://jackett:9117/api/v2.0/indexers/example-source/results/torznab/api', apiKey: 'j' },
  ], { fetch })
  await filtered.search('x')
  await full.search('x')
  assert.equal(fetch.calls[0].url.pathname, '/api/v2.0/indexers/tag%3Atv%2C!type%3Aprivate/results/torznab/api')
  assert.equal(fetch.calls[0].url.searchParams.get('apikey'), 'j')
  assert.equal(fetch.calls[1].url.pathname, '/api/v2.0/indexers/example-source/results/torznab/api')
})

test('health checks use the same authenticated endpoint shape as sources', () => {
  const torznab = sourceHealthRequest({ type: 'torznab', url: 'http://indexer:9117/api', apiKey: 'key' })
  assert.equal(torznab.url.searchParams.get('t'), 'caps')
  assert.equal(torznab.url.searchParams.get('apikey'), 'key')
  const jackett = sourceHealthRequest({ type: 'jackett', url: 'http://jackett:9117', apiKey: 'key', indexer: 'all' })
  assert.equal(jackett.url.pathname, '/api/v2.0/indexers/all/results/torznab/api')
  assert.equal(jackett.url.searchParams.get('apikey'), 'key')
  const prowlarr = sourceHealthRequest({ type: 'prowlarr', url: 'http://prowlarr:9696/base', apiKey: 'key' })
  assert.equal(prowlarr.url.pathname, '/base/api/v1/health')
  assert.deepEqual(prowlarr.headers, { 'X-Api-Key': 'key' })
})

test('unknown source types and bad URLs fail at startup', () => {
  assert.throws(() => createSources([{ type: 'unknown', name: 'x', url: 'http://x' }]), /Unknown source type: unknown/)
  assert.throws(() => sourcesFromEnv({ TORZNAB_URL: 'bitmagnet:3333' }), /Not an http\(s\) URL/)
  assert.throws(() => sourcesFromEnv({ PROWLARR_URL: 'prowlarr' }), /Not an http\(s\) URL/)
})

test('download links: proxy redirect to a magnet, redirect chains, .torrent bodies, magnet bodies, errors', async () => {
  const torrentBytes = Buffer.from('d8:announce0:4:infod4:name1:xee')
  const fetch = mockFetch(url => {
    switch (url.pathname) {
      case '/3/download': return { status: 301, headers: { location: 'magnet:?xt=urn:btih:d797d14fb859b0f4f70e6081080ff28135830522' } }
      case '/hop': return { status: 302, headers: { location: '/dl/x/' } }
      case '/dl/x/': return { body: torrentBytes, headers: { 'content-type': 'application/x-bittorrent' } }
      case '/magnet-body': return { body: 'magnet:?xt=urn:btih:2222222222222222222222222222222222222222\n' }
      case '/gone': return { status: 404 }
    }
  })
  assert.match(await resolveLink('http://prowlarr:9696/3/download?apikey=k&link=x', { fetch }), /^magnet:\?xt=urn:btih:d797/)
  assert.deepEqual(await resolveLink('http://jackett:9117/hop', { fetch }), torrentBytes)
  assert.equal(fetch.calls.at(-1).url.href, 'http://jackett:9117/dl/x/')
  assert.equal(await resolveLink('http://jackett:9117/magnet-body', { fetch }), 'magnet:?xt=urn:btih:2222222222222222222222222222222222222222')
  await assert.rejects(resolveLink('http://jackett:9117/gone', { fetch }), err => err.status === 502 && /HTTP 404/.test(err.message))
})

test('finds BitMagnet for Explore', () => {
  assert.equal(bitmagnetUrl({}, sourcesFromEnv({})), null)
  assert.equal(bitmagnetUrl({ BITMAGNET_URL: 'http://10.0.0.5:3333/torznab/api' }, []), 'http://10.0.0.5:3333')
  // Jackett's feed also ends in /torznab/api, but not at the root
  assert.equal(bitmagnetUrl({}, sourcesFromEnv({ JACKETT_URL: 'http://jackett:9117', TORZNAB_URL: 'http://hydra:5076/api' })), null)
})
