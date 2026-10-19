// GET /raw and /tar: torrent bytes over HTTP with Range, validators and cancellation.
import type { IncomingMessage, ServerResponse } from 'node:http'
import { pipeline, Readable } from 'node:stream'
import { attachment, notModified, rangeFor } from '@magplay/http-kit'
import { tarBytes, tarLayout } from '@magplay/seekable-tar'
import type { TorrentEngine } from '@magplay/torrent-engine'

interface Body {
  size: number
  type: string
  etag: string
  /** Sent as an attachment with this name. */
  filename?: string | false
}

type Bytes = (start: number, end: number, signal: AbortSignal) => AsyncIterable<Uint8Array>

/** Sends a byte range of `size` bytes produced by `bytes(start, end)`, keeping the torrent loaded while it streams. */
function send (req: IncomingMessage, res: ServerResponse, engine: TorrentEngine, ih: string, { size, type, etag, filename }: Body, bytes: Bytes): void {
  const headers = {
    'Cache-Control': 'private, max-age=3600, must-revalidate',
    ETag: etag,
    'Accept-Ranges': 'bytes',
    'Content-Type': type,
    ...(filename && { 'Content-Disposition': attachment(filename) })
  }
  if (notModified(req, etag)) {
    res.writeHead(304, headers)
    res.end()
    return
  }
  // Range applies to GET only, never HEAD. Evaluate cache preconditions first.
  const range = rangeFor(req.method === 'HEAD' ? {} : req.headers, size, etag)
  if (!range) {
    res.writeHead(416, { 'Cache-Control': 'no-store', 'Content-Range': `bytes */${size}` })
    res.end()
    return
  }
  const { start, end, partial } = range
  res.writeHead(partial ? 206 : 200, {
    ...headers,
    'Content-Length': end - start + 1,
    ...(partial && { 'Content-Range': `bytes ${start}-${end}/${size}` }),
  })
  if (req.method === 'HEAD' || size === 0) {
    res.end()
    return
  }
  const release = engine.openStream(ih)
  // Cancel the inner WebTorrent reader too: an outer async generator can be
  // blocked waiting for a missing piece and cannot finish on its own.
  const controller = new AbortController()
  const abort = (): void => controller.abort()
  res.once('close', abort)
  pipeline(Readable.from(bytes(start, end, controller.signal)), res, () => {
    res.off('close', abort)
    release()
  })
}

/** GET /raw/:ih/:idx: the file's bytes with Range support. The single source for the browser, the probe, ffmpeg and downloads. */
export async function serveRaw (req: IncomingMessage, res: ServerResponse, engine: TorrentEngine, ih: string, idx: number, { download = false } = {}): Promise<void> {
  const file = await engine.file(ih, idx)
  send(req, res, engine, ih, { size: file.length, type: file.type, etag: `"${ih}-${idx}"`, filename: download && file.name }, file.read)
}

/** GET /tar/:ih: every file in the torrent as one tar archive, resumable like any other download. */
export async function serveTar (req: IncomingMessage, res: ServerResponse, engine: TorrentEngine, ih: string): Promise<void> {
  const torrent = await engine.get(ih)
  // A fixed mtime keeps the archive byte-identical across requests, so ranges from a resumed download line up
  const mtime = torrent.created ? torrent.created.getTime() / 1000 : 0
  const layout = tarLayout(torrent.files, mtime)
  // Creation date is outside the infohash but changes archive headers. Version the tar encoding too.
  send(req, res, engine, ih, { size: layout.size, type: 'application/x-tar', etag: `"${ih}-tar-v1-${mtime}"`, filename: `${torrent.name}.tar` },
    (start, end, signal) => tarBytes(layout, start, end, (i, from, to) => torrent.files[i]!.read(from, to, signal)))
}
