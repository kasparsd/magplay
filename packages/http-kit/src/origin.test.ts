import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { IncomingMessage } from 'node:http'
import { isCrossSite } from './origin.ts'

const req = (headers: Record<string, string>): IncomingMessage => ({ headers }) as unknown as IncomingMessage

test('a page on another site is cross-site; this site and clients that aren’t browsers are not', () => {
  assert.equal(isCrossSite(req({ 'sec-fetch-site': 'same-origin', host: 'server:8080' })), false)
  assert.equal(isCrossSite(req({ 'sec-fetch-site': 'none', host: 'server:8080' })), false)
  assert.equal(isCrossSite(req({ 'sec-fetch-site': 'cross-site', origin: 'http://server:8080', host: 'server:8080' })), true)
  assert.equal(isCrossSite(req({ 'sec-fetch-site': 'same-site', host: 'server:8080' })), true)
  assert.equal(isCrossSite(req({ origin: 'http://server:8080', host: 'server:8080' })), false)
  assert.equal(isCrossSite(req({ origin: 'http://evil.example', host: 'server:8080' })), true)
  assert.equal(isCrossSite(req({ origin: 'null', host: 'server:8080' })), true)
  // curl, scripts and other apps send neither header
  assert.equal(isCrossSite(req({ host: 'server:8080' })), false)
})
