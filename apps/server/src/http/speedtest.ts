// GET /api/speedtest: a byte faucet for the browser's connection test.
import { randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'

// Random content, so a compressing proxy can't make the link look faster than it is. Made on first use.
let chunk: Buffer | null = null
export const SPEEDTEST_MAX_BYTES = 256 * 1024 * 1024

/** Streams one reused 1 MB buffer until the client stops reading, disconnects, or `maxBytes` is sent. */
export function serveSpeedtest (req: IncomingMessage, res: ServerResponse, { maxBytes = SPEEDTEST_MAX_BYTES } = {}): void {
  res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' })
  const block = chunk ??= randomBytes(1024 * 1024)
  let sent = 0
  const pump = (): void => {
    // destroyed turns true when the browser aborts the download
    while (!res.destroyed && sent < maxBytes) {
      const part = sent + block.length > maxBytes ? block.subarray(0, maxBytes - sent) : block
      sent += part.length
      if (!res.write(part)) {
        res.once('drain', pump)
        return
      }
    }
    if (!res.destroyed) res.end()
  }
  pump()
}
