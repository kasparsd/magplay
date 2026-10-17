import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FileNotFoundError, MalformedPathError } from '@magplay/http-kit'
import { HttpError, toHttpError } from './errors.ts'

test('maps typed errors to statuses; anything else is an unexpected 500', () => {
  assert.deepEqual(toHttpError(new HttpError(503, 'Busy', { retryAfter: 5 })), { status: 503, message: 'Busy', retryAfter: 5, unexpected: false })
  assert.deepEqual(toHttpError(new MalformedPathError('Malformed URL encoding')), { status: 400, message: 'Malformed URL encoding', retryAfter: undefined, unexpected: false })
  assert.deepEqual(toHttpError(new FileNotFoundError('Not found')), { status: 404, message: 'Not found', retryAfter: undefined, unexpected: false })
  assert.deepEqual(toHttpError(new TypeError('boom')), { status: 500, message: 'boom', retryAfter: undefined, unexpected: true })
  assert.deepEqual(toHttpError('weird'), { status: 500, message: 'weird', retryAfter: undefined, unexpected: true })
})
