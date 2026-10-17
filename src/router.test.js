import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRouter } from './router.js'

const match = createRouter([
  ['GET', '/', 'home'],
  ['GET', '/playlist.m3u', 'playlist'],
  ['GET', '/t/:ih?', 'torrent'],
  ['GET|HEAD', '/raw/:ih/:idx/:name?', 'raw'],
  ['DELETE|POST', '/api/play/:session', 'stop'],
])

test('matches methods, required and optional params', () => {
  assert.deepEqual(match('GET', '/'), { handler: 'home', params: {} })
  assert.deepEqual(match('GET', '/t'), { handler: 'torrent', params: {} })
  assert.deepEqual(match('GET', '/t/abc'), { handler: 'torrent', params: { ih: 'abc' } })
  assert.deepEqual(match('HEAD', '/raw/abc/2'), { handler: 'raw', params: { ih: 'abc', idx: '2' } })
  assert.deepEqual(match('GET', '/raw/abc/2/Show%20S01E01.mkv'), { handler: 'raw', params: { ih: 'abc', idx: '2', name: 'Show S01E01.mkv' } })
  assert.equal(match('POST', '/api/play/s1').handler, 'stop')
})

test('no match for other methods, extra segments or missing params', () => {
  assert.equal(match('POST', '/'), null)
  assert.equal(match('GET', '/raw/abc'), null)
  assert.equal(match('GET', '/raw/abc/2/name/extra'), null)
  assert.equal(match('GET', '/api/play/s1'), null)
  assert.equal(match('GET', '/nope'), null)
})

test('static route names are literal, not regular expressions', () => {
  assert.equal(match('GET', '/playlist.m3u').handler, 'playlist')
  assert.equal(match('GET', '/playlistXm3u'), null)
})

test('malformed percent encoding is a client error', () => {
  assert.throws(() => match('GET', '/t/%ZZ'), { status: 400, message: 'Malformed URL encoding' })
})

test('a trailing slash is accepted', () => {
  assert.deepEqual(match('GET', '/t/abc/'), { handler: 'torrent', params: { ih: 'abc' } })
})
