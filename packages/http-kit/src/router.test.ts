import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRouter, route } from './router.ts'
import type { RouteParams } from './router.ts'
import { MalformedPathError } from './errors.ts'

const home = (): void => {}
const playlist = (): void => {}
const torrent = (): void => {}
const raw = (): void => {}
const stop = (): void => {}

const match = createRouter([
  route('GET', '/', home),
  route('GET', '/playlist.m3u', playlist),
  route('GET', '/t/:ih?', torrent),
  route('GET|HEAD', '/raw/:ih/:idx/:name?', raw),
  route('DELETE|POST', '/api/play/:session', stop),
])

test('matches methods, required and optional params', () => {
  assert.deepEqual(match('GET', '/'), { handler: home, params: {} })
  assert.deepEqual(match('GET', '/t'), { handler: torrent, params: {} })
  assert.deepEqual(match('GET', '/t/abc'), { handler: torrent, params: { ih: 'abc' } })
  assert.deepEqual(match('HEAD', '/raw/abc/2'), { handler: raw, params: { ih: 'abc', idx: '2' } })
  assert.deepEqual(match('GET', '/raw/abc/2/Show%20S01E01.mkv'), { handler: raw, params: { ih: 'abc', idx: '2', name: 'Show S01E01.mkv' } })
  assert.equal(match('POST', '/api/play/s1')?.handler, stop)
})

test('no match for other methods, extra segments or missing params', () => {
  assert.equal(match('POST', '/'), null)
  assert.equal(match('GET', '/raw/abc'), null)
  assert.equal(match('GET', '/raw/abc/2/name/extra'), null)
  assert.equal(match('GET', '/api/play/s1'), null)
  assert.equal(match('GET', '/nope'), null)
})

test('static route names are literal, not regular expressions', () => {
  assert.equal(match('GET', '/playlist.m3u')?.handler, playlist)
  assert.equal(match('GET', '/playlistXm3u'), null)
})

test('malformed percent encoding is a typed error', () => {
  assert.throws(() => match('GET', '/t/%ZZ'), err => err instanceof MalformedPathError && err.message === 'Malformed URL encoding')
})

test('a trailing slash is accepted', () => {
  assert.deepEqual(match('GET', '/t/abc/'), { handler: torrent, params: { ih: 'abc' } })
})

test('handlers see params typed from the pattern', () => {
  route('GET', '/raw/:ih/:idx/:name?', ({ params }) => {
    const required: string = params.ih + params.idx
    const optional: string | undefined = params.name
    // @ts-expect-error the pattern captures no such param
    const missing: unknown = params.other
    return [required, optional, missing]
  })
  const typed: RouteParams<'/title/:type/:id'> = { type: 'movie', id: '1' }
  assert.deepEqual(typed, { type: 'movie', id: '1' })
})
