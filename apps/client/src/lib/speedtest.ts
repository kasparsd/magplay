export interface ConnectionResult { at: number, downBytesPerSec: number, latencyMs: number }
export interface ConnectionMeasureOptions {
  fetchImpl?: typeof fetch
  now?: () => number
}

/** Measure the local path only when the person asks; no background network traffic. */
export async function measureConnection ({ fetchImpl = fetch, now = () => performance.now() }: ConnectionMeasureOptions = {}): Promise<ConnectionResult> {
  const latencies: number[] = []
  for (let i = 0; i < 5; i++) {
    const at = now()
    const response = await fetchImpl('/health', { cache: 'no-store' })
    if (!response.ok) throw new Error('Could not measure connection latency.')
    await response.json()
    latencies.push(now() - at)
  }
  latencies.sort((a, b) => a - b)
  const controller = new AbortController()
  const stop = setTimeout(() => controller.abort(), 6000)
  const at = now()
  let bytes = 0
  let warmupBytes = 0
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  try {
    const response = await fetchImpl('/api/speedtest', { signal: controller.signal, cache: 'no-store' })
    if (!response.ok || !response.body) throw new Error('Could not measure the connection.')
    reader = response.body.getReader()
    while (now() - at < 5500) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (now() - at < 1000) warmupBytes = bytes
    }
  } catch (err) {
    if (!(err instanceof DOMException && err.name === 'AbortError')) throw err
  } finally {
    clearTimeout(stop)
    controller.abort()
    await reader?.cancel().catch(() => {})
  }
  const seconds = Math.max(0.1, (now() - at - 1000) / 1000)
  return { at: Date.now(), downBytesPerSec: Math.max(0, bytes - warmupBytes) / seconds, latencyMs: latencies[2] ?? 0 }
}
