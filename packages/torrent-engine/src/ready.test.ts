import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { waitForTorrent } from './ready.ts'
import { TorrentFailedError, TorrentTimeoutError } from './errors.ts'

class FakeTorrent extends EventEmitter {
  ready = false
  metadata = false
  destroyed = false
  destroy (): void { this.destroyed = true; this.emit('close') }
}
const options = { metadataMs: 1000, checkingMs: 1000 }

test('metadata and cached-piece checking have independent deadlines and clean listeners', async () => {
  const t = new FakeTorrent()
  const ready = waitForTorrent(t, options)
  t.metadata = true
  t.emit('metadata')
  t.ready = true
  t.emit('ready')
  assert.equal(await ready, t)
  for (const name of ['metadata', 'ready', 'error', 'close']) assert.equal(t.listenerCount(name), 0)
})

test('metadata timeout destroys the pending load and has a retryable explanation', async () => {
  const t = new FakeTorrent()
  await assert.rejects(waitForTorrent(t, { ...options, metadataMs: 5 }), new TorrentTimeoutError('No peers found for this torrent in 0.005 s; try another release'))
  assert.equal(t.destroyed, true)
})

test('already-known metadata uses checking timeout, not the shorter metadata deadline', async () => {
  const t = new FakeTorrent()
  t.metadata = true
  const result = waitForTorrent(t, { metadataMs: 1, checkingMs: 15 })
  await assert.rejects(result, err => err instanceof TorrentTimeoutError && /TORRENT_CHECK_TIMEOUT_S/.test(err.message))
  assert.equal(t.destroyed, true)
})

test('close/error before ready reject rather than stranding shared callers', async () => {
  for (const event of ['close', 'error']) {
    const t = new FakeTorrent()
    const result = waitForTorrent(t, options)
    t.emit(event, new Error('peer failure'))
    await assert.rejects(result, TorrentFailedError)
    assert.equal(t.listenerCount('ready'), 0)
  }
})
