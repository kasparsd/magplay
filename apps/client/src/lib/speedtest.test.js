import assert from 'node:assert/strict'
import { test } from 'node:test'
import { measureConnection } from './speedtest.ts'

test('connection measurement cancels the speed stream when its timed sample ends', async () => {
  let cancelled = false
  let speedSignal
  let ticks = 0
  const now = () => ticks++ * 1000
  const stream = new ReadableStream({
    pull (controller) { controller.enqueue(new Uint8Array(1024)) },
    cancel () { cancelled = true },
  })
  const fetch = async (url, init) => {
    if (url === '/health') return Response.json({ ok: true })
    speedSignal = init?.signal
    return new Response(stream)
  }
  const result = await measureConnection({ fetchImpl: fetch, now })
  assert.equal(cancelled, true)
  assert.equal(speedSignal?.aborted, true)
  assert.ok(result.downBytesPerSec >= 0)
})
