import { test } from 'node:test'
import assert from 'node:assert/strict'
import { connectionLevel, measureConnection, readConnection, saveConnection, CONNECTION_MAX_AGE_MS } from './speedtest.ts'
import { getPreference, readPreferences, setPreference } from './preferences.ts'

function memoryStorage (): Storage {
  const data = new Map<string, string>()
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v) } } as unknown as Storage
}

test('measureConnection takes the median ping and excludes the warmup from the download speed', async () => {
  let clock = 0
  const pings = [30, 10, 20, 50, 40]
  let ping = 0
  const fetch = ((url: string) => {
    if (url === '/health') {
      clock += pings[ping++]!
      return Promise.resolve(new Response('{}'))
    }
    // 10 chunks of 1 MB, one every 500 ms
    let sent = 0
    return Promise.resolve(new Response(new ReadableStream({
      pull (controller) {
        clock += 500
        if (sent++ >= 10) return controller.close()
        controller.enqueue(new Uint8Array(1_000_000))
      },
    })))
  }) as unknown as typeof globalThis.fetch
  const r = await measureConnection({ fetch, now: () => clock, warmupMs: 1000, durationMs: 4000 })
  assert.equal(r.latencyMs, 30)
  // Chunks at 500…4000 ms; measuring starts at the 1000 ms chunk and counts 6 MB over 3 s
  assert.equal(r.downBytesPerSec, 2_000_000)
})

test('connection levels: unknown when never run or a week old, warn when slow', () => {
  const now = 1e12
  assert.equal(connectionLevel(null, now), 'unknown')
  assert.equal(connectionLevel({ at: now - CONNECTION_MAX_AGE_MS - 1, downBytesPerSec: 50e6, latencyMs: 5 }, now), 'unknown')
  assert.equal(connectionLevel({ at: now, downBytesPerSec: 6e6, latencyMs: 5 }, now), 'warn')
  assert.equal(connectionLevel({ at: now, downBytesPerSec: 50e6, latencyMs: 150 }, now), 'warn')
  assert.equal(connectionLevel({ at: now, downBytesPerSec: 50e6, latencyMs: 5 }, now), 'ok')
})

test('results and preferences round-trip through storage, and bad stored values fall back to defaults', () => {
  const store = memoryStorage()
  assert.equal(readConnection(store), null)
  saveConnection({ at: 1, downBytesPerSec: 2, latencyMs: 3 }, store)
  assert.deepEqual(readConnection(store), { at: 1, downBytesPerSec: 2, latencyMs: 3 })

  assert.equal(getPreference('player.speed', store), 1)
  assert.equal(setPreference('player.speed', 1.25, store), true)
  assert.equal(setPreference('player.speed', 3, store), false)
  assert.equal(getPreference('player.speed', store), 1.25)
  assert.equal(store.getItem('magplay:player:speed'), '1.25')
  // Values the Player wrote with remember(): its keys, its codes, null for no audio preference
  store.setItem('magplay:player:volume', '7')
  store.setItem('magplay:player:subtitleLanguage', '"eng"')
  store.setItem('magplay:player:audioLanguage', 'null')
  const prefs = readPreferences(store)
  assert.equal(prefs['player.volume'], 1)
  assert.equal(prefs['player.subtitleLanguage'], 'eng')
  assert.equal(prefs['player.audioLanguage'], '')
  assert.equal(setPreference('player.audioLanguage', '', store), true)
  assert.equal(store.getItem('magplay:player:audioLanguage'), 'null')
  assert.equal(setPreference('player.subtitleLanguage', 'not a language', store), false)
  assert.equal(getPreference('player.autoplayNext', null), true)
})
