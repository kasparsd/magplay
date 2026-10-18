import { test } from 'node:test'
import assert from 'node:assert/strict'
import { redactDeep, redactSecrets } from '@magplay/api-contract'

test('API keys in query strings, URL passwords and X-Api-Key values are removed', () => {
  assert.equal(redactSecrets('GET http://jackett:9117/api/v2.0/indexers/all/results/torznab/api?t=search&apikey=abc123&q=x'),
    'GET http://jackett:9117/api/v2.0/indexers/all/results/torznab/api?t=search&apikey=***&q=x')
  assert.equal(redactSecrets('http://h/dl/x?jackett_apikey=k1&path=p'), 'http://h/dl/x?jackett_apikey=***&path=p')
  assert.equal(redactSecrets('feed https://user:hunter2@indexer.lan/api'), 'feed https://user:***@indexer.lan/api')
  assert.equal(redactSecrets('{"X-Api-Key":"s3cret"}'), '{"X-Api-Key":"***"}')
  assert.equal(redactSecrets('X-Api-Key: s3cret'), 'X-Api-Key: ***')
})

test('ordinary text and URLs without secrets are unchanged', () => {
  for (const s of ['http://bitmagnet:3333/torznab/api?t=search&q=keyboard', 'magplay listening on :8080', 'monkey=1&donkey=2', 'http://host:8080/path']) {
    assert.equal(redactSecrets(s), s)
  }
})

test('redactDeep walks objects and arrays', () => {
  assert.deepEqual(redactDeep({ a: ['http://x/?apikey=1'], b: { c: 2, d: 'http://u:p@h/' } }), { a: ['http://x/?apikey=***'], b: { c: 2, d: 'http://u:***@h/' } })
})
