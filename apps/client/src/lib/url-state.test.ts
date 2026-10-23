import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parse, serialize, urlState } from './url-state.ts'
import type { UrlHost } from './url-state.ts'

const schema = {
  type: { default: 'movie' },
  sort: { default: 'seeders', values: ['seeders', 'added'] },
  genre: { default: '' },
}

function fakeHost (search = ''): UrlHost & { entries: string[], pop: (search: string) => void } {
  let current = search
  let popped = (): void => {}
  const entries: string[] = []
  return {
    entries,
    search: () => current,
    pathname: () => '/explore',
    push: url => { entries.push(url); current = url.slice('/explore'.length) },
    replace: url => { entries[entries.length - 1] = url; current = url.slice('/explore'.length) },
    onPop: listener => { popped = listener },
    pop: search => { current = search; popped() },
  }
}

test('reads defaults for missing, blank and disallowed values', () => {
  assert.deepEqual(parse(schema, '?sort=bogus&genre=%20'), { type: 'movie', sort: 'seeders', genre: '' })
  assert.deepEqual(parse(schema, '?type=tv&sort=added&genre=Drama'), { type: 'tv', sort: 'added', genre: 'Drama' })
})

test('writes leave out defaults and keep schema order', () => {
  assert.equal(serialize(schema, { genre: 'Drama', type: 'movie', sort: 'added' }), '?sort=added&genre=Drama')
  assert.equal(serialize(schema, { type: 'movie', sort: 'seeders', genre: '' }), '')
})

test('push makes an entry, replace does not, and unchanged state writes nothing', () => {
  const host = fakeHost()
  const state = urlState(schema, host)
  assert.equal(state.set({ genre: 'Drama' }, { push: true }), true)
  assert.equal(state.set({ sort: 'added' }), true)
  assert.deepEqual(host.entries, ['/explore?sort=added&genre=Drama'])
  assert.equal(state.set({ genre: 'Drama' }, { push: true }), false)
  assert.equal(host.entries.length, 1)
})

test('Back reports the state of the entry it lands on', () => {
  const host = fakeHost('?type=tv')
  const seen: unknown[] = []
  urlState(schema, host).onChange(s => seen.push(s))
  host.pop('?genre=Comedy')
  assert.deepEqual(seen, [{ type: 'movie', sort: 'seeders', genre: 'Comedy' }])
})
