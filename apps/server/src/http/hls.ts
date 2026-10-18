// GET /hls/:session/:file: an HLS session's playlist, init segment, media segments and WebVTT files.
import fs from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import path from 'node:path'
import { serveFile } from '@magplay/http-kit'
import type { HlsSessions } from '@magplay/playback'

const TYPES: Readonly<Record<string, string>> = { m3u8: 'application/vnd.apple.mpegurl', mp4: 'video/mp4', m4s: 'video/iso.segment', vtt: 'text/vtt' }

export async function serveHls (req: IncomingMessage, res: ServerResponse, sessions: HlsSessions, id: string, file: string): Promise<void> {
  const s = sessions.touch(id)
  if (!s || !/^[\w-]+\.(m3u8|mp4|m4s|vtt)$/.test(file)) {
    res.writeHead(404, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' })
    res.end('No such session or file')
    return
  }
  // ffmpeg publishes .m4s via atomic rename (temp_file). Revalidate to honor session cleanup.
  if (file.endsWith('.m4s')) return serveFile(req, res, path.join(s.dir, file), TYPES.m4s!, 'private, no-cache')
  const stream = fs.createReadStream(path.join(s.dir, file))
  stream.on('error', () => {
    // Not written yet; tell the player whether to keep waiting
    if (res.headersSent) {
      res.destroy()
      return
    }
    res.writeHead(s.exitCode ? 500 : 404, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' })
    res.end(s.exitCode ? `ffmpeg failed: ${s.stderr.at(-1) ?? 'unknown error'}` : 'Not ready yet')
  })
  res.on('close', () => stream.destroy())
  stream.on('open', () => {
    res.writeHead(200, { 'Content-Type': TYPES[file.split('.').pop() ?? ''] ?? 'application/octet-stream', 'Cache-Control': 'no-store' })
    if (req.method === 'HEAD') {
      stream.destroy()
      res.end()
    } else {
      stream.pipe(res)
    }
  })
}
