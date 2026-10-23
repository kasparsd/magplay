// GET /hls/:session/:file: an HLS session's playlist, init segment, media segments and WebVTT subtitles.
// A segment ffmpeg hasn't made yet is waited for (the session restarts ffmpeg there if it is far away); leaving
// the request cancels the wait.
import fs from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { pipeline } from 'node:stream/promises'
import { FileNotFoundError } from '@magplay/http-kit'
import type { HlsSessions } from '@magplay/playback'

const NO_STORE = { 'Cache-Control': 'no-store' }

function send (res: ServerResponse, type: string, body: string | Buffer): void {
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(body), ...NO_STORE })
  res.end(body)
}

export async function serveHls (req: IncomingMessage, res: ServerResponse, sessions: HlsSessions, id: string, file: string): Promise<void> {
  const left = new AbortController()
  res.on('close', () => left.abort())
  try {
    await respond(req, res, sessions, id, file, left.signal)
  } catch (err) {
    if (!left.signal.aborted) throw err // hls.js gave up on the request (a seek, or the page closed): nothing to answer
  }
}

async function respond (req: IncomingMessage, res: ServerResponse, sessions: HlsSessions, id: string, file: string, signal: AbortSignal): Promise<void> {
  if (file === 'index.m3u8') return send(res, 'application/vnd.apple.mpegurl', await sessions.playlist(id, signal))
  if (file === 'init.mp4') return send(res, 'video/mp4', await fs.promises.readFile(await sessions.init(id, signal)))
  const sub = /^sub_(\d+)\.vtt$/.exec(file)
  if (sub) return send(res, 'text/vtt; charset=utf-8', sessions.subtitles(id, Number(sub[1])))
  const segment = /^seg_(\d+)\.m4s$/.exec(file)
  if (!segment) throw new FileNotFoundError('No such file')
  // A segment is its fragments, one after another; published files never change
  const files = await sessions.segment(id, Number(segment[1]), signal)
  const sizes = await Promise.all(files.map(async f => (await fs.promises.stat(f)).size))
  res.writeHead(200, { 'Content-Type': 'video/iso.segment', 'Content-Length': sizes.reduce((a, b) => a + b, 0), ...NO_STORE })
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  for (const f of files) await pipeline(fs.createReadStream(f), res, { end: false, signal })
  res.end()
}
