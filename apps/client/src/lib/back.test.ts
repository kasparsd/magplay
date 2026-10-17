import { test } from 'node:test'
import assert from 'node:assert/strict'
import { backTarget } from './back.ts'

const origin = 'http://nas:8080'

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
  assert.equal(backTarget('http://nas:8080.evil.test/?q=x', origin), null) // the origin must end at a slash
})
