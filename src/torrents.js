import fs from 'node:fs/promises'
import path from 'node:path'
import { pipeline, Readable } from 'node:stream'
import WebTorrent from 'webtorrent'
import parseTorrent from 'parse-torrent'
import config, { httpError } from './config.js'
import { contentWarning, listFiles } from './episodes.js'
import { resolveLink } from './sources/links.js'
import { notModified } from './http-cache.js'
import { createLimiter } from './limits.js'
import { waitForTorrent } from './torrent-ready.js'
import { attachment, rangeFor } from './range.js'
import { tarLayout, tarBytes } from './tar.js'

const runTorrentLoad = createLimiter(config.maxTorrentLoads, 'Torrent initialization')

const torrentsDir = path.join(config.cacheDir, 'torrents')
const client = new WebTorrent({
  torrentPort: config.torrentPort,
  dhtPort: config.torrentPort,
  dht: config.dhtEnabled,
  lsd: config.lsdEnabled,
  natUpnp: false, // inside Docker; publish the port in Compose instead
  natPmp: false,
  utp: false, // uTP would bind the same UDP port as the DHT; peers connect over TCP

})
client.on('error', err => console.error('[torrent] client error:', err.message))

const lastUsed = new Map() // infoHash -> ms
const openStreams = new Map() // infoHash -> number of open /raw streams
const pending = new Map() // infoHash -> Promise<torrent> while waiting for metadata

function touch (ih) {
  const prev = lastUsed.get(ih) ?? 0
  const now = Date.now()
  lastUsed.set(ih, now)
  // The folder mtime is the LRU key for cache eviction, so it survives restarts
  if (now - prev > 60_000) fs.utimes(path.join(torrentsDir, ih), new Date(), new Date()).catch(() => {})
}

const findTorrent = ih => client.torrents.find(t => t.infoHash === ih)

/** Adds (or reuses) a torrent and waits until its metadata is known. Nothing is selected for download. */
export async function addTorrent ({ infoHash, magnet, link }) {
  let id = magnet || infoHash
  if (!id && link) id = await resolveLink(link)
  if (!id) throw httpError(400, 'Send infoHash, magnet or linkId')
  let parsed
  try {
    parsed = await parseTorrent(id)
  } catch {
    throw httpError(400, 'Not a valid magnet, info hash or torrent file')
  }
  if (!parsed?.infoHash) throw httpError(400, 'Not a valid magnet, info hash or torrent file')
  const ih = parsed.infoHash
  touch(ih)

  const existing = findTorrent(ih)
  if (existing?.ready) return existing
  if (pending.has(ih)) return pending.get(ih)
  // Publish the whole initialization job before its first filesystem await.
  // Player title/probe requests often arrive together on a cold cache.
  const job = runTorrentLoad(() => loadTorrent(ih, parsed, existing))
  pending.set(ih, job)
  try {
    return await job
  } finally {
    if (pending.get(ih) === job) pending.delete(ih)
  }
}

async function loadTorrent (ih, parsed, existing) {
  // Metadata saved on an earlier visit: no need to wait for peers to send it again
  const metaFile = path.join(torrentsDir, ih, 'meta.torrent')
  const saved = await fs.readFile(metaFile).catch(() => null)
  if (saved && !existing) parsed = await parseTorrent(saved)

  parsed.announce = [...new Set([...(parsed.announce ?? []), ...config.extraTrackers])]
  const torrent = existing || client.add(parsed, { path: path.join(torrentsDir, ih), deselect: true })
  await waitForTorrent(torrent, { metadataMs: config.metadataTimeoutMs, checkingMs: config.checkingTimeoutMs })
  if (!saved) fs.mkdir(path.dirname(metaFile), { recursive: true }).then(() => fs.writeFile(metaFile, torrent.torrentFile)).catch(err => console.error('[torrent] saving metadata:', err.message))
  return torrent
}

// Notes from file lists we've seen, so later searches show them even when the title looks playable
const warnings = new Map()

export function describe (torrent) {
  const files = listFiles(torrent)
  const warning = contentWarning(files)
  warnings.delete(torrent.infoHash)
  if (warning) warnings.set(torrent.infoHash, warning)
  if (warnings.size > 5000) warnings.delete(warnings.keys().next().value)
  return { infoHash: torrent.infoHash, name: torrent.name, files, warning }
}

export const knownWarning = infoHash => warnings.get(infoHash) ?? null

/** A loaded torrent, re-adding it by info hash if it was unloaded. */
export async function getTorrent (ih) {
  if (!/^[a-f0-9]{40}$/.test(ih)) throw httpError(400, 'Bad info hash')
  const torrent = findTorrent(ih)?.ready ? findTorrent(ih) : await addTorrent({ infoHash: ih })
  touch(ih)
  return torrent
}

/** A file of a loaded torrent, re-adding the torrent by info hash if it was unloaded. */
export async function getFile (ih, idx) {
  const file = (await getTorrent(ih)).files[idx]
  if (!file) throw httpError(404, 'No such file in this torrent')
  return file
}

/** Bytes start..end (inclusive) of a torrent file. WebTorrent reads end=0 as "to the end", so cap the bytes ourselves. */
async function * fileBytes (file, start, end, signal) {
  let left = end - start + 1
  const iterator = file[Symbol.asyncIterator]({ start, end: Math.max(end, 1) })
  let abort
  const cancelled = new Promise((resolve, reject) => { abort = () => reject(signal.reason) })
  signal.addEventListener('abort', abort, { once: true })
  try {
    if (signal.aborted) abort()
    while (left > 0) {
      // WebTorrent's stream wrapper can wait forever for a missing piece even
      // after destroy(). Race the iterator directly and release its selection.
      const { value: chunk, done } = await Promise.race([iterator.next(), cancelled])
      if (done) return
      const piece = chunk.length > left ? chunk.subarray(0, left) : chunk
      left -= piece.length
      yield piece
    }
  } finally {
    signal.removeEventListener('abort', abort)
    await iterator.return?.()
  }
}

/** Sends a byte range of `size` bytes produced by `bytes(start, end)`, keeping the torrent loaded while it streams. */
function send (req, res, ih, { size, type, etag, filename }, bytes) {
  const headers = { 'Cache-Control': 'private, max-age=3600, must-revalidate', ETag: etag, 'Accept-Ranges': 'bytes',
    'Content-Type': type, ...(filename && { 'Content-Disposition': attachment(filename) }) }
  if (notModified(req, etag)) {
    res.writeHead(304, headers)
    return res.end()
  }
  // Range applies to GET only, never HEAD. Evaluate cache preconditions first.
  const range = rangeFor(req.method === 'HEAD' ? {} : req.headers, size, etag)
  if (!range) {
    res.writeHead(416, { 'Cache-Control': 'no-store', 'Content-Range': `bytes */${size}` })
    return res.end()
  }
  const { start, end, partial } = range
  res.writeHead(partial ? 206 : 200, {
    ...headers,
    'Content-Length': end - start + 1,
    ...(partial && { 'Content-Range': `bytes ${start}-${end}/${size}` }),
  })
  if (req.method === 'HEAD' || size === 0) return res.end()
  openStreams.set(ih, (openStreams.get(ih) ?? 0) + 1)
  // Cancel the inner WebTorrent reader too: an outer async generator can be
  // blocked waiting for a missing piece and cannot finish on its own.
  const controller = new AbortController()
  const abort = () => controller.abort()
  res.once('close', abort)
  pipeline(Readable.from(bytes(start, end, controller.signal)), res, () => {
    res.off('close', abort)
    const remaining = (openStreams.get(ih) || 1) - 1
    if (remaining) openStreams.set(ih, remaining)
    else openStreams.delete(ih)
    touch(ih)
  })
}

/** GET /raw/:ih/:idx: the file's bytes with Range support. The single source for the browser, ffmpeg, ffprobe and downloads. */
export async function serveRaw (req, res, ih, idx, { download = false } = {}) {
  const file = await getFile(ih, idx)
  send(req, res, ih, { size: file.length, type: file.type, etag: `"${ih}-${idx}"`, filename: download && file.name },
    (start, end, signal) => fileBytes(file, start, end, signal))
}

/** GET /tar/:ih: every file in the torrent as one tar archive, resumable like any other download. */
export async function serveTar (req, res, ih) {
  const torrent = await getTorrent(ih)
  // A fixed mtime keeps the archive byte-identical across requests, so ranges from a resumed download line up
  const mtime = torrent.created ? torrent.created.getTime() / 1000 : 0
  const layout = tarLayout(torrent.files, mtime)
  // Creation date is outside the infohash but changes archive headers. Version the tar encoding too.
  send(req, res, ih, { size: layout.size, type: 'application/x-tar', etag: `"${ih}-tar-v1-${mtime}"`, filename: `${torrent.name}.tar` },
    (start, end, signal) => tarBytes(layout, start, end, (i, from, to) => fileBytes(torrent.files[i], from, to, signal)))
}

/** Downloaded parts of a file as [from, to] fractions of its length. */
function fileRanges (t, file) {
  const n = file._endPiece - file._startPiece + 1
  const ranges = []
  let runStart = -1
  for (let i = 0; i <= n; i++) {
    const have = i < n && t.bitfield.get(file._startPiece + i)
    if (have && runStart < 0) runStart = i
    if (!have && runStart >= 0) { ranges.push([runStart / n, i / n]); runStart = -1 }
  }
  return ranges
}

/** How much of the torrent a peer has, from its piece bitfield (seeders announce "have all" without one). */
function peerShare (wire, pieces) {
  const bits = wire.peerPieces
  if (bits?.constructor?.name === 'HaveAllBitField') return 1
  let have = 0
  for (const byte of bits?.buffer?.subarray(0, Math.ceil(pieces / 8)) ?? []) {
    for (let b = byte; b; b >>= 1) have += b & 1
  }
  return pieces ? Math.min(1, have / pieces) : 0
}

const decoder = new TextDecoder()

/**
 * GET /api/torrents/:ih/status: live view of a loaded torrent; never loads one.
 * With `idx` (the player watching a file) it adds that file's downloaded ranges and keeps the torrent loaded.
 */
export function status (ih, { idx } = {}) {
  const t = findTorrent(ih)
  if (!t?.ready) return { loaded: false }
  const file = idx != null ? t.files[idx] : null
  if (file) touch(ih)
  const pieces = t.pieces.length
  const peers = t.wires.map(w => ({
    address: !w.remoteAddress ? null : w.remoteAddress.includes(':') ? `[${w.remoteAddress}]:${w.remotePort}` : `${w.remoteAddress}:${w.remotePort}`,
    client: w.peerExtendedHandshake?.v ? decoder.decode(w.peerExtendedHandshake.v).slice(0, 40) : null,
    type: w.type,
    downloadSpeed: w.downloadSpeed(),
    uploadSpeed: w.uploadSpeed(),
    downloaded: w.downloaded,
    uploaded: w.uploaded,
    share: peerShare(w, pieces),
    choking: w.peerChoking, // not sending to us right now
  })).sort((a, b) => b.downloadSpeed - a.downloadSpeed || b.downloaded - a.downloaded)
  return {
    loaded: true,
    activeStreams: openStreams.get(ih) || 0,
    downloadSpeed: t.downloadSpeed,
    uploadSpeed: t.uploadSpeed,
    downloaded: t.downloaded,
    length: t.length,
    progress: t.progress,
    files: t.files.map((f, i) => ({ idx: i, progress: f.done ? 1 : f.progress })),
    peers,
    ...(file && { file: { idx, progress: file.done ? 1 : file.progress, ranges: fileRanges(t, file) } }),
  }
}

/** GET /api/recent: torrents with metadata in the cache, most recently used first. */
export async function recent (limit = 20) {
  const names = (await fs.readdir(torrentsDir).catch(() => [])).filter(n => /^[a-f0-9]{40}$/.test(n))
  const entries = await Promise.all(names.map(async ih => {
    const dir = path.join(torrentsDir, ih)
    const [meta, stat] = await Promise.all([fs.readFile(path.join(dir, 'meta.torrent')).catch(() => null), fs.stat(dir).catch(() => null)])
    if (!meta || !stat) return null
    const parsed = await parseTorrent(meta).catch(() => null)
    return parsed && { infoHash: ih, name: parsed.name, length: parsed.length, lastUsed: Math.max(stat.mtimeMs, lastUsed.get(ih) ?? 0), dir }
  }))
  const list = entries.filter(Boolean).sort((a, b) => b.lastUsed - a.lastUsed).slice(0, limit)
  // How much is on the NAS; the folder holds the data and the metadata file
  return Promise.all(list.map(async ({ dir, ...e }) => ({ ...e, onDisk: Math.min(e.length, await dirBytes(dir)) })))
}

async function dirBytes (dir) {
  let total = 0
  for (const entry of await fs.readdir(dir, { recursive: true, withFileTypes: true }).catch(() => [])) {
    // blocks counts what's actually on disk; torrent files are sparse
    if (entry.isFile()) total += await fs.stat(path.join(entry.parentPath, entry.name)).then(s => s.blocks * 512, () => 0)
  }
  return total
}

/** Unloads idle torrents (keeping their data) and evicts least-recently-used folders above CACHE_MAX_GB. */
async function housekeeping () {
  for (const t of [...client.torrents]) {
    const idle = Date.now() - (lastUsed.get(t.infoHash) ?? 0) > config.idleTorrentMs
    if (idle && !openStreams.get(t.infoHash) && !pending.has(t.infoHash)) {
      console.log(`[torrent] unloading idle ${t.infoHash} ${t.name ?? ''}`)
      t.destroy()
    }
  }
  const names = await fs.readdir(torrentsDir).catch(() => [])
  const dirs = await Promise.all(names.map(async name => {
    const dir = path.join(torrentsDir, name)
    const stat = await fs.stat(dir).catch(() => null)
    return { name, dir, mtime: stat?.mtimeMs ?? 0, bytes: await dirBytes(dir) }
  }))
  let total = dirs.reduce((sum, d) => sum + d.bytes, 0)
  for (const d of dirs.sort((a, b) => a.mtime - b.mtime)) {
    if (total <= config.cacheMaxBytes) break
    if (findTorrent(d.name)) continue // in use
    console.log(`[cache] evicting ${d.name} (${(d.bytes / 1024 ** 3).toFixed(1)} GB)`)
    await fs.rm(d.dir, { recursive: true, force: true })
    total -= d.bytes
  }
}

let housekeepingRunning = false
setInterval(() => {
  if (housekeepingRunning) return
  housekeepingRunning = true
  housekeeping().catch(err => console.error('[cache]', err.message)).finally(() => { housekeepingRunning = false })
}, 60_000).unref()
