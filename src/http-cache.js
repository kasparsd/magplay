import fs from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { pipeline } from 'node:stream'

/** GET/HEAD use weak comparison; If-None-Match takes precedence even when it does not match. */
export function notModified (req, etag, modified) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false
  const match = req.headers['if-none-match']
  if (match !== undefined) {
    const tags = match.match(/(?:W\/)?"[^"\r\n]*"|\*/g) || []
    return tags.some(tag => tag === '*' || tag.replace(/^W\//, '') === etag.replace(/^W\//, ''))
  }
  const since = Date.parse(req.headers['if-modified-since'])
  return modified !== undefined && Number.isFinite(since) && Math.floor(modified / 1000) * 1000 <= since
}

/** Small, already materialized representations only; never hash torrent/media streams. */
export function sendCached (req, res, body, headers, policy = 'private, no-cache') {
  const etag = `"${createHash('sha256').update(body).digest('hex')}"`
  const out = { ...headers, 'Cache-Control': policy, ETag: etag }
  if (notModified(req, etag)) {
    res.writeHead(304, out)
    return res.end()
  }
  res.writeHead(200, { ...out, 'Content-Length': Buffer.byteLength(body) })
  res.end(req.method === 'HEAD' ? undefined : body)
}

/** Open before sending headers: missing files are normal HTTP errors, not unhandled stream errors. */
export async function serveFile (req, res, target, type, policy = 'no-cache') {
  let handle
  try {
    handle = await fs.open(target, 'r')
    const stat = await handle.stat()
    if (!stat.isFile()) throw Object.assign(new Error('Not found'), { code: 'ENOENT' })
    // Metadata validators are weak: no per-request reads/hashes of large files.
    const etag = `W/"${stat.ino.toString(16)}-${stat.size.toString(16)}-${stat.mtimeMs.toString(16)}-${stat.ctimeMs.toString(16)}"`
    const headers = { 'Content-Type': type, 'Cache-Control': policy, ETag: etag, 'Last-Modified': stat.mtime.toUTCString() }
    if (notModified(req, etag, stat.mtimeMs)) {
      res.writeHead(304, headers)
      return res.end()
    }
    res.writeHead(200, { ...headers, 'Content-Length': stat.size })
    if (req.method === 'HEAD') return res.end()
    const stream = handle.createReadStream()
    handle = null // stream now owns the descriptor
    pipeline(stream, res, () => {})
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') throw Object.assign(new Error('Not found'), { status: 404 })
    throw err
  } finally {
    await handle?.close()
  }
}
