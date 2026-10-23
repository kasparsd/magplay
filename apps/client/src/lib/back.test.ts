import { test } from 'node:test'
import assert from 'node:assert/strict'
import { backTarget, returnTarget } from './back.ts'
import type { BackTarget, ReturnStore } from './back.ts'

const origin = 'http://server:8080'

test('search results, Explore, titles and the home list are worth going back to', () => {
  assert.deepEqual(backTarget(`${origin}/?q=bunny&cat=2000`, origin), { label: '← Results', href: '/?q=bunny&cat=2000', history: true })
  assert.deepEqual(backTarget(`${origin}/explore?type=tv_show`, origin), { label: '← Explore', href: '/explore?type=tv_show', history: true })
  assert.equal(backTarget(`${origin}/title/movie/tmdb/98?title=Gladiator&year=2000`, origin)?.label, '← Gladiator')
  assert.equal(backTarget(`${origin}/`, origin)?.label, '← Recently opened')
})

test('direct links, other sites and other pages fall back', () => {
  const fallback = { label: '← Explore', href: '/explore' }
  assert.equal(backTarget('', origin), null)
  assert.deepEqual(backTarget('', origin, fallback), { ...fallback, history: false })
  assert.deepEqual(backTarget('https://example.com/?q=x', origin, fallback), { ...fallback, history: false })
  assert.equal(backTarget(`${origin}/play/abc/0`, origin), null)
  assert.equal(backTarget('http://server:8080.evil.test/?q=x', origin), null) // the origin must end at a slash
})

const memoryReturns = (): ReturnStore => {
  const map = new Map<string, Omit<BackTarget, 'history'>>()
  return { get: page => map.get(page) ?? null, set: (page, target) => { map.set(page, target) } }
}

test('a page reached from a catalog page remembers it and later links to it by URL', () => {
  const store = memoryReturns()
  assert.deepEqual(returnTarget('/t/abc', `${origin}/?q=bunny`, origin, store), { label: '← Results', href: '/?q=bunny', history: true })
  assert.deepEqual(returnTarget('/t/abc', `${origin}/play/abc/1`, origin, store), { label: '← Results', href: '/?q=bunny', history: false })
  assert.equal(returnTarget('/t/other', `${origin}/play/other/1`, origin, store), null)
})

test('a direct visit uses the fallback, not what the tab remembered', () => {
  const store = memoryReturns()
  const fallback = { label: '← Explore', href: '/explore' }
  returnTarget('/title/movie/tmdb/1', `${origin}/explore?genre=Drama`, origin, store, fallback)
  assert.deepEqual(returnTarget('/title/movie/tmdb/1', `${origin}/t/abc`, origin, store, fallback), { label: '← Explore', href: '/explore?genre=Drama', history: false })
  assert.deepEqual(returnTarget('/title/movie/tmdb/1', '', origin, store, fallback), { ...fallback, history: false })
})
