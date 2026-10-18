import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import pino from 'pino'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createLogging, sanitize } from './logger.ts'

test('stdout and tail contain identical safe structured records, with isolated context', async () => {
  const printed: string[] = []
  const logging = createLogging({ level: 'debug', version: 'test', sink: { write: line => { printed.push(line) } } })
  const child = logging.logger.child({ component: 'probe', operationId: 'op', err: { Token: 'nested-token', apiKey: 'api-secret' } })
  child.error('probe.failed', { err: new Error('GET https://user:pw@private/film?apikey=topsecret failed', { cause: new Error('Authorization: Bearer secret') }) })
  logging.logger.info('server.ok', { stderr: 'Unable to write /data/private-film/output.m4s', request: { authorization: 'not-approved' } })
  await logging.flush()
  assert.deepEqual(printed.map(s => JSON.parse(s) as unknown), logging.tail())
  assert.doesNotMatch(printed.join(''), /topsecret|private|user:pw|Bearer secret|not-approved|private-film/)
  assert.equal(logging.tail()[0]?.operationId, 'op')
  assert.equal(logging.tail()[1]?.operationId, undefined)
  const snapshot = logging.tail()
  snapshot[0]!.event = 'mutated'
  assert.equal(logging.tail()[0]?.event, 'probe.failed')
  assert.deepEqual(sanitize({ Token: 'nested-token', child: { API_KEY: 'api-secret' } }), { Token: '***', child: { API_KEY: '***' } })
})

test('normalization handles cycles, accessors and bounded UTF-8 JSON; the tail stays bounded', () => {
  const printed: string[] = []
  const logging = createLogging({ level: 'info', sink: { write: line => { printed.push(line) } } })
  const cyclic: Record<string, unknown> = { token: 'hidden' }
  cyclic.self = cyclic
  Object.defineProperty(cyclic, 'getter', { get () { throw new Error('must not run') } })
  logging.logger.info('oversized', { err: cyclic, reason: '🎥'.repeat(100_000) })
  for (let i = 0; i < 240; i++) logging.logger.info('bounded', { err: { stack: '🎥'.repeat(10_000), cause: { stack: 'x'.repeat(10_000) } } })
  for (const line of printed) {
    assert.ok(Buffer.byteLength(line) <= 8192)
    assert.doesNotThrow(() => JSON.parse(line) as unknown)
  }
  assert.ok(logging.tail().length <= 200)
  assert.ok(Buffer.byteLength(JSON.stringify(logging.tail())) <= 512 * 1024)
})

test('level filtering, sink failure and loss accounting do not alter global console', async () => {
  const original = console.log
  const sink = Object.assign(new EventEmitter(), { write () { throw new Error('closed collector') } })
  const logging = createLogging({ level: 'warn', sink })
  logging.logger.debug('suppressed')
  logging.logger.warn('retained')
  sink.emit('drop')
  sink.emit('error', new Error('broken'))
  logging.logger.error('still.retained')
  await logging.flush()
  assert.equal(logging.tail().length, 2)
  assert.equal(logging.status().dropped, 4)
  assert.equal(console.log, original)
})

test('the actual asynchronous destination enforces its queue bound and reports drops', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'magplay-log-'))
  const sink = pino.destination({ dest: path.join(dir, 'out'), sync: false, minLength: 1024, maxLength: 1024 })
  const logging = createLogging({ sink })
  t.after(() => { sink.destroy(); fs.rmSync(dir, { recursive: true, force: true }) })
  // A burst before the asynchronous file open completes exceeds the destination budget.
  for (let i = 0; i < 100; i++) logging.logger.info('burst', { reason: 'x'.repeat(512) })
  assert.ok(logging.status().dropped > 0)
  await logging.flush()
})
