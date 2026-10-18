import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FileNotFoundError, MalformedPathError } from '@magplay/http-kit'
import { LinkExpired, NoSourcesError, SearchTimeout, SourceError } from '@magplay/indexers'
import { EngineBusyError, InvalidTorrentError, NoSuchFileError, TorrentFailedError, TorrentTimeoutError } from '@magplay/torrent-engine'
import { HttpError, toHttpError } from './errors.ts'

test('maps typed errors to statuses; anything else is an unexpected 500', () => {
  assert.deepEqual(toHttpError(new HttpError(503, 'Busy', { retryAfter: 5 })), { status: 503, message: 'Busy', retryAfter: 5, unexpected: false })
  assert.deepEqual(toHttpError(new MalformedPathError('Malformed URL encoding')), { status: 400, message: 'Malformed URL encoding', retryAfter: undefined, unexpected: false })
  assert.deepEqual(toHttpError(new FileNotFoundError('Not found')), { status: 404, message: 'Not found', retryAfter: undefined, unexpected: false })
  const status = (err: unknown) => toHttpError(err).status
  assert.deepEqual([new SourceError('x'), new NoSourcesError('x'), new SearchTimeout('x'), new LinkExpired('x')].map(status), [502, 503, 504, 410])
  assert.deepEqual([new InvalidTorrentError('x'), new NoSuchFileError('x'), new TorrentTimeoutError('x'), new TorrentFailedError('x')].map(status), [400, 404, 504, 502])
  assert.deepEqual(toHttpError(new EngineBusyError('Busy')), { status: 503, message: 'Busy', retryAfter: 5, unexpected: false })
  assert.deepEqual(toHttpError(new TypeError('boom')), { status: 500, message: 'boom', retryAfter: undefined, unexpected: true })
  assert.deepEqual(toHttpError('weird'), { status: 500, message: 'weird', retryAfter: undefined, unexpected: true })
})
