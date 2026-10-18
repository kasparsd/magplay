import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSources, jackettFeedUrl } from './sources.ts'
import { resolveLink } from './links.ts'
import { SourceError } from './errors.ts'
import { mockFetch } from './test-helpers.ts'

test('Jackett preset builds the feed URL, or keeps a full one', async () => {
  const fetch = mockFetch(() => ({ body: '<rss><channel></channel></rss>' }))
  const [filtered, full] = createSources([
    { type: 'jackett', name: 'J', url: 'http://jackett:9117/', apiKey: 'j', indexer: 'tag:tv,!type:private' },
    { type: 'jackett', name: 'J2', url: 'http://jackett:9117/api/v2.0/indexers/example-source/results/torznab/api', apiKey: 'j' },
  ], { fetch })
  await filtered!.search('x', { signal: AbortSignal.timeout(1000) })
  await full!.search('x', { signal: AbortSignal.timeout(1000) })
  assert.equal(fetch.calls[0]?.url.pathname, '/api/v2.0/indexers/tag%3Atv%2C!type%3Aprivate/results/torznab/api')
  assert.equal(fetch.calls[0]?.url.searchParams.get('apikey'), 'j')
  assert.equal(fetch.calls[1]?.url.pathname, '/api/v2.0/indexers/example-source/results/torznab/api')
  assert.equal(jackettFeedUrl('http://jackett:9117'), 'http://jackett:9117/api/v2.0/indexers/all/results/torznab/api')
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
  assert.match(String(await resolveLink('http://prowlarr:9696/3/download?apikey=k&link=x', { fetch })), /^magnet:\?xt=urn:btih:d797/)
  assert.deepEqual(await resolveLink('http://jackett:9117/hop', { fetch }), torrentBytes)
  assert.equal(fetch.calls.at(-1)?.url.href, 'http://jackett:9117/dl/x/')
  assert.equal(await resolveLink('http://jackett:9117/magnet-body', { fetch }), 'magnet:?xt=urn:btih:2222222222222222222222222222222222222222')
  await assert.rejects(resolveLink('http://jackett:9117/gone', { fetch }), err => err instanceof SourceError && /HTTP 404/.test(err.message))
})
