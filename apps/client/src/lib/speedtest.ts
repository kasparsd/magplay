// The connection test: latency to the server and download speed from its byte faucet, run on demand.
import { STORAGE_KEYS } from './preferences.ts'
import type { PreferenceStorage } from './preferences.ts'

export interface ConnectionResult {
  /** When it ran, ms since the epoch. */
  at: number
  downBytesPerSec: number
  latencyMs: number
}

export interface MeasureOptions {
  fetch?: typeof globalThis.fetch
  /** A monotonic clock in ms. */
  now?: () => number
  pings?: number
  /** The first part of the download is ignored while TCP ramps up. */
  warmupMs?: number
  durationMs?: number
}

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

/** Median of a few /health round trips, then about 5 s of /api/speedtest with the first second excluded. */
export async function measureConnection ({ fetch = globalThis.fetch.bind(globalThis), now = () => performance.now(), pings = 5, warmupMs = 1000, durationMs = 5000 }: MeasureOptions = {}): Promise<ConnectionResult> {
  const times: number[] = []
  for (let i = 0; i < pings; i++) {
    const started = now()
    const res = await fetch('/health', { cache: 'no-store' })
    await res.arrayBuffer()
    times.push(now() - started)
  }

  const controller = new AbortController()
  const stop = setTimeout(() => controller.abort(), durationMs + 3000) // a stalled read still ends
  try {
    const res = await fetch('/api/speedtest', { cache: 'no-store', signal: controller.signal })
    if (!res.ok || !res.body) throw new Error(`The speed test failed (HTTP ${res.status})`)
    const reader = res.body.getReader()
    const started = now()
    let total = 0
    let measured = 0
    let from: number | null = null
    let last = started
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      last = now()
      total += value.byteLength
      if (last - started >= warmupMs) {
        if (from === null) from = last
        else measured += value.byteLength
      }
      if (last - started >= durationMs) break
    }
    controller.abort()
    reader.cancel().catch(() => {})
    // A link fast enough to drain the faucet during warmup still gets a number
    const down = from !== null && last > from ? measured / ((last - from) / 1000) : total / (Math.max(1, last - started) / 1000)
    return { at: Date.now(), downBytesPerSec: down, latencyMs: median(times) }
  } finally {
    clearTimeout(stop)
  }
}

export const CONNECTION_MAX_AGE_MS = 7 * 24 * 3600_000
/** Below this a local network struggles with high-bitrate files. */
export const SLOW_BYTES_PER_SEC = 10e6
export const SLOW_LATENCY_MS = 100

/** ok, warn (slow), or unknown when never run or older than a week. */
export function connectionLevel (result: ConnectionResult | null, now = Date.now()): 'ok' | 'warn' | 'unknown' {
  if (!result || now - result.at > CONNECTION_MAX_AGE_MS) return 'unknown'
  return result.downBytesPerSec < SLOW_BYTES_PER_SEC || result.latencyMs > SLOW_LATENCY_MS ? 'warn' : 'ok'
}

function defaultStorage (): PreferenceStorage | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

export function readConnection (store = defaultStorage()): ConnectionResult | null {
  try {
    const r = JSON.parse(store?.getItem(STORAGE_KEYS.connection) ?? 'null') as Partial<ConnectionResult> | null
    return r && typeof r.at === 'number' && typeof r.downBytesPerSec === 'number' && typeof r.latencyMs === 'number'
      ? { at: r.at, downBytesPerSec: r.downBytesPerSec, latencyMs: r.latencyMs }
      : null
  } catch {
    return null
  }
}

export function saveConnection (result: ConnectionResult, store = defaultStorage()): void {
  try {
    store?.setItem(STORAGE_KEYS.connection, JSON.stringify(result))
  } catch {}
}
