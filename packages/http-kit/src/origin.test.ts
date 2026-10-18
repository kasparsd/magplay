import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { IncomingMessage } from 'node:http'
import { isSameOrigin } from './origin.ts'

const req = (headers: Record<string, string>): IncomingMessage => ({ headers }) as unknown as IncomingMessage

test('writes are allowed only from this origin', () => {
  assert.equal(isSameOrigin(req({ 'sec-fetch-site': 'same-origin', host: 'nas:8080' })), true)
  assert.equal(isSameOrigin(req({ 'sec-fetch-site': 'cross-site', origin: 'http://nas:8080', host: 'nas:8080' })), false)
  assert.equal(isSameOrigin(req({ 'sec-fetch-site': 'same-site', host: 'nas:8080' })), false)
  assert.equal(isSameOrigin(req({ origin: 'http://nas:8080', host: 'nas:8080' })), true)
  assert.equal(isSameOrigin(req({ origin: 'http://evil.example', host: 'nas:8080' })), false)
  assert.equal(isSameOrigin(req({ origin: 'null', host: 'nas:8080' })), false)
  assert.equal(isSameOrigin(req({ host: 'nas:8080' })), false)
})
