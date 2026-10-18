import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSearchService } from './search.ts'
import { toHttpError } from '../http/errors.ts'

const hash = '0123456789abcdef0123456789abcdef01234567'
const search = (warning: string | null = null) => createSearchService({ sources: () => [], timeoutMs: () => 100, engine: { knownWarning: () => warning } })

test('magnet search works without sources and preserves tracker and web seed hints', async () => {
  const magnet = `magnet:?xt=urn:btih:${hash}&dn=Example.1080p.x264&tr=udp%3A%2F%2Ftracker.example%3A80&ws=https%3A%2F%2Fseed.example%2F`
  const out = await search().search(`  ${magnet}  `, '5000')
  assert.deepEqual(out.sources, [])
  assert.equal(out.results.length, 1)
  assert.equal(out.results[0]?.infoHash, hash)
  assert.equal(out.results[0]?.title, 'Example.1080p.x264')
  assert.equal(out.results[0]?.magnet, magnet)
  assert.equal(out.results[0]?.seeders, null)
  assert.equal(out.results[0]?.size, null)
  assert.equal(out.results[0]?.linkId, null)
})

test('base32 magnets and unnamed magnets have a normalized hash and useful title', async () => {
  const out = await search().search('MAGNET:?xt=urn%3Abtih%3AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', null)
  const infoHash = '0'.repeat(40)
  assert.equal(out.results[0]?.infoHash, infoHash)
  assert.equal(out.results[0]?.title, `Torrent ${infoHash}`)
  assert.equal(out.results[0]?.magnet, `magnet:?xt=urn:btih:${'a'.repeat(32)}`)
})

test('magnet search keeps warnings already learned from torrent files', async () => {
  const out = await search('No media file found').search(`magnet:?xt=urn:btih:${hash}&dn=Movie.x264`, null)
  assert.equal(out.results[0]?.warning, 'No media file found')
  assert.equal(out.results[0]?.likelyDirect, false)
})

test('malformed and unsupported magnets return a readable client error', async () => {
  for (const q of ['magnet:', 'magnet:?dn=Example', 'magnet:?xt=urn:btih:nope', `magnet:?xt=urn:btih:${hash}extra`, `magnet:?xt=urn:btmh:1220${'a'.repeat(64)}`]) {
    await assert.rejects(search().search(q, null), err => {
      assert.equal(toHttpError(err).status, 400)
      assert.match(toHttpError(err).message, /valid magnet link/)
      return true
    })
  }
})

test('ordinary text still requires sources and empty input is rejected', async () => {
  await assert.rejects(search().search('Example', null), err => toHttpError(err).status === 503)
  await assert.rejects(search().search('  ', null), err => toHttpError(err).status === 400)
})
