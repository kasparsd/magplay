import { randomUUID } from 'node:crypto'
import { noopLogger, noopMetrics, observeJob, outcome } from '@magplay/observability'
import type { Logger, Metrics, OperationContext } from '@magplay/observability'
// The torrent engine: one WebTorrent client, a metadata store and cache on disk, deadlines for loading,
// idle unloading and size-based eviction. Created by createTorrentEngine() and released by close().
import fs from 'node:fs/promises'
import path from 'node:path'
import WebTorrent from 'webtorrent'
import type { Torrent as WtTorrent, TorrentFile as WtFile } from 'webtorrent'
import parseTorrent from 'parse-torrent'
import type { ParsedTorrent } from 'parse-torrent'
import { contentWarning, listFiles } from '@magplay/release-info'
import type { ListedFile, TorrentLike } from '@magplay/release-info'
import { EngineBusyError, InvalidTorrentError, NoSuchFileError } from './errors.ts'
import { createLimiter } from './limits.ts'
import { waitForTorrent } from './ready.ts'
import { activity } from './activity.ts'
import type { TorrentActivity } from './activity.ts'
import { dirBytes, evict, listCached } from './store.ts'
import type { RecentTorrent } from './store.ts'

/** Settings read on each use, so a saved change applies without a restart. */
export interface LiveOptions {
  /** Torrents loading (waiting for metadata or checking) at once; more fail fast with EngineBusyError. */
  maxLoads: number
  /** Added to every torrent's announce list. */
  extraTrackers: readonly string[]
  metadataTimeoutMs: number
  checkingTimeoutMs: number
  /** Unused this long (and not streaming), a torrent is unloaded; its data stays. */
  idleMs: number
  /** Least-recently-used torrent folders are deleted above this. */
  cacheMaxBytes: number
  /** Keep sharing loaded, complete torrents until they have uploaded `ratio` times their size. */
  seeding: { enabled: boolean, ratio: number }
}

export const DEFAULT_LIVE: LiveOptions = {
  maxLoads: 4,
  extraTrackers: [],
  metadataTimeoutMs: 60_000,
  checkingTimeoutMs: 7_200_000,
  idleMs: 30 * 60_000,
  cacheMaxBytes: 50 * 1024 ** 3,
  seeding: { enabled: true, ratio: 1 },
}

/** Seeded torrents kept loaded at once; extras being watched may exceed it until they finish. */
const MAX_SEEDED = 3
/** Upload cap while anything is streaming, so playback wins but the swarm still gets some bytes. */
const PLAYBACK_UPLOAD_BYTES_PER_SEC = 128 * 1024
/** A seeded torrent with no peers and no upload for this long is unloaded; its data stays. */
const SEED_IDLE_MS = 24 * 60 * 60_000

export interface TorrentEngineOptions {
  logger?: Logger
  metrics?: Metrics
  /** Torrent data and saved metadata, one folder per info hash. */
  dir: string
  /** TCP and DHT port; 0 picks a free one. */
  port: number
  dht: boolean
  lsd: boolean
  live?: () => LiveOptions
  /** How often idle torrents are unloaded and the cache is trimmed. */
  housekeepingMs?: number
}

export interface TorrentFile {
  name: string
  path: string
  length: number
  /** MIME type from the file name. */
  type: string
  /** Bytes start..end (inclusive), as they arrive from peers. Aborting `signal` stops waiting for a missing piece. */
  read: (start: number, end: number, signal: AbortSignal) => AsyncGenerator<Uint8Array>
}

export interface Torrent {
  infoHash: string
  name: string
  /** Creation date from the metadata, if any. */
  created: Date | null
  files: TorrentFile[]
}

export interface TorrentInfo {
  infoHash: string
  name: string
  files: ListedFile[]
  warning: string | null
}

export interface TorrentEngine {
  /** A file list from a ready torrent or saved metadata; activates only torrents whose metadata is not cached. */
  info: (id: string | Uint8Array) => Promise<TorrentInfo>
  /** Adds (or reuses) a torrent by magnet, info hash or .torrent bytes and waits for its file list. Nothing is selected for download. */
  add: (id: string | Uint8Array, context?: OperationContext) => Promise<Torrent>
  /** A loaded torrent, re-adding it by info hash if it was unloaded. */
  get: (infoHash: string, context?: OperationContext) => Promise<Torrent>
  /** A file of a torrent, loading the torrent if needed. */
  file: (infoHash: string, idx: number, context?: OperationContext) => Promise<TorrentFile>
  /** The file list as the pages show it, with a content warning; warnings are remembered for knownWarning(). */
  describe: (torrent: Torrent) => TorrentInfo
  /** A warning from a file list seen earlier, so search results can show it. */
  knownWarning: (infoHash: string) => string | null
  /** Live view of a loaded torrent; never loads one. With `idx`, adds that file's ranges and keeps the torrent loaded. */
  status: (infoHash: string, options?: { idx?: number | undefined }) => TorrentActivity
  /** Torrents with metadata in the cache, most recently used first. */
  recent: (limit?: number) => Promise<RecentTorrent[]>
  /** Counts a stream of a torrent's bytes, which keeps it loaded; call the returned function when it ends. */
  openStream: (infoHash: string) => () => void
  /** Busy loading slots, loaded and seeded torrents and total upload speed (bytes/s), for the Debug page. */
  stats: () => { loads: { used: number, limit: number }, loaded: number, seeded: number, uploadSpeed: number }
  /** Bytes the torrent cache holds on disk. */
  cacheBytes: () => Promise<number>
  /** Unloads idle torrents and evicts folders above the cache limit. Runs on a timer; exposed for tests. */
  housekeeping: () => Promise<void>
  /** Stops the timer and destroys the client, closing its ports and connections. Data on disk stays. */
  close: () => Promise<void>
}

const INFO_HASH = /^[a-f0-9]{40}$/

async function parseId (id: string | Uint8Array): Promise<ParsedTorrent> {
  try {
    const parsed = await parseTorrent(id)
    if (parsed?.infoHash && INFO_HASH.test(parsed.infoHash)) return parsed
  } catch {}
  throw new InvalidTorrentError('Not a valid magnet, info hash or torrent file')
}

/** Bytes start..end (inclusive) of a torrent file. WebTorrent reads end=0 as "to the end", so cap the bytes ourselves. */
async function * fileBytes (file: WtFile, start: number, end: number, signal: AbortSignal): AsyncGenerator<Uint8Array> {
  let left = end - start + 1
  const iterator = file[Symbol.asyncIterator]({ start, end: Math.max(end, 1) })
  let abort = (): void => {}
  const cancelled = new Promise<never>((_resolve, reject) => { abort = () => reject(signal.reason as Error) })
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

export function createTorrentEngine ({ dir, port, dht, lsd, live = () => DEFAULT_LIVE, housekeepingMs = 60_000, logger = noopLogger, metrics = noopMetrics }: TorrentEngineOptions): TorrentEngine {
  let stopping = false
  const runLoad = createLimiter(() => live().maxLoads, () => { metrics.reject('torrent', 'capacity'); logger.warn('resource.rejected', { resource: 'torrent', reason: 'capacity' }); return new EngineBusyError('Torrent initialization is busy. Try again shortly.') })
  const client = new WebTorrent({
    torrentPort: port,
    dhtPort: port,
    dht,
    lsd,
    natUpnp: false, // inside Docker; publish the port in Compose instead
    natPmp: false,
    utp: false, // uTP would bind the same UDP port as the DHT; peers connect over TCP
  })
  client.on('error', (err: Error) => logger.error('torrent.client.failed', { err }))

  const lastUsed = new Map<string, number>() // infoHash -> ms
  const openStreams = new Map<string, number>() // infoHash -> number of open streams
  const seeded = new Map<string, number>() // infoHash -> ms of last peer or upload, oldest seeded first
  const uploadedBefore = new Map<string, number>() // infoHash -> bytes uploaded in earlier loads, from seed.json
  const uploadedSaved = new Map<string, number>() // infoHash -> total last written to seed.json
  const jobIds = new Map<string, string>()
  const pending = new Map<string, Promise<Torrent>>() // infoHash -> load waiting for metadata
  // Notes from file lists we've seen, so later searches show them even when the title looks playable
  const warnings = new Map<string, string>()
  const handles = new WeakMap<WtTorrent, Torrent>()

  function touch (ih: string): void {
    const prev = lastUsed.get(ih) ?? 0
    const now = Date.now()
    lastUsed.set(ih, now)
    // The folder mtime is the LRU key for cache eviction, so it survives restarts
    if (now - prev > 60_000) fs.utimes(path.join(dir, ih), new Date(), new Date()).catch(() => {})
  }

  const find = (ih: string): WtTorrent | undefined => client.torrents.find(t => t.infoHash === ih)

  const busy = (ih: string): boolean => !!openStreams.get(ih) || pending.has(ih)

  // WebTorrent's `uploaded` counts from zero for each added torrent, so earlier loads' bytes come from seed.json
  const uploadedTotal = (t: WtTorrent): number => (uploadedBefore.get(t.infoHash) ?? 0) + t.uploaded
  const ratioReached = (t: WtTorrent): boolean => uploadedTotal(t) / t.length >= live().seeding.ratio

  async function saveUploaded (t: WtTorrent): Promise<void> {
    const ih = t.infoHash
    if (!uploadedBefore.has(ih)) return
    const total = uploadedTotal(t)
    if (total === uploadedSaved.get(ih)) return
    uploadedSaved.set(ih, total)
    await fs.mkdir(path.join(dir, ih), { recursive: true })
      .then(() => fs.writeFile(path.join(dir, ih, 'seed.json'), JSON.stringify({ uploaded: total })))
      .catch((err: unknown) => logger.error('torrent.seed.save.failed', { err, torrentId: ih }))
  }

  /** Starts seeding a loaded torrent whose data is all on disk and that is still under the ratio. */
  function seed (t: WtTorrent): void {
    if (!live().seeding.enabled || seeded.has(t.infoHash) || !t.ready || !t.length) return
    if (!(t.done || t.progress === 1) || ratioReached(t)) return
    seeded.set(t.infoHash, Date.now())
  }

  /** Saves the upload total, then destroys the handle; the data stays on disk. */
  async function unload (t: WtTorrent, reason: string): Promise<void> {
    await saveUploaded(t)
    seeded.delete(t.infoHash)
    logger.info('torrent.unloaded', { torrentId: t.infoHash, reason })
    t.destroy()
  }

  function handle (t: WtTorrent): Torrent {
    let h = handles.get(t)
    if (!h) {
      h = {
        infoHash: t.infoHash,
        name: t.name ?? t.infoHash,
        created: t.created ?? null,
        files: t.files.map(f => ({
          name: f.name,
          path: f.path,
          length: f.length,
          type: f.type,
          read: (start, end, signal) => fileBytes(f, start, end, signal),
        })),
      }
      handles.set(t, h)
    }
    return h
  }

  async function load (ih: string, parsed: ParsedTorrent, existing: WtTorrent | undefined, log: Logger): Promise<Torrent> {
    // Metadata saved on an earlier visit: no need to wait for peers to send it again
    const folder = path.join(dir, ih)
    const metaFile = path.join(folder, 'meta.torrent')
    const modtimesFile = path.join(folder, 'modtimes.json')
    const saved = await fs.readFile(metaFile).catch(() => null)
    const savedModtimes = await fs.readFile(modtimesFile).then(b => JSON.parse(b.toString()) as number[]).catch(() => undefined)
    const savedUploaded = await fs.readFile(path.join(folder, 'seed.json'))
      .then(b => (JSON.parse(b.toString()) as { uploaded?: unknown }).uploaded).catch(() => 0)
    if (saved && !existing) parsed = await parseTorrent(saved)
    const { extraTrackers, metadataTimeoutMs, checkingTimeoutMs } = live()
    parsed.announce = [...new Set([...(parsed.announce ?? []), ...extraTrackers])]
    const addNew = (): WtTorrent => {
      const added = client.add(parsed, { path: folder, deselect: true, ...(savedModtimes ? { fileModtimes: savedModtimes } : {}) })
      const before = typeof savedUploaded === 'number' && Number.isFinite(savedUploaded) && savedUploaded > 0 ? savedUploaded : 0
      uploadedBefore.set(ih, before)
      uploadedSaved.set(ih, before)
      added.on('done', () => seed(added))
      added.on('close', () => {
        seeded.delete(ih)
        uploadedBefore.delete(ih)
        uploadedSaved.delete(ih)
      })
      return added
    }
    const torrent = existing ?? addNew()
    let checkingAt: number | undefined
    let result: ReturnType<typeof outcome> = 'success'
    try {
      await waitForTorrent(torrent, {
        metadataMs: metadataTimeoutMs,
        checkingMs: checkingTimeoutMs,
        onMetadata: () => {
          checkingAt ??= performance.now()
          log.debug('torrent.metadata.ready', { cacheClass: saved ? 'warm' : 'cold' })
        }
      })
    } catch (err) { result = outcome(err); throw err } finally {
      if (checkingAt !== undefined) {
        const durationMs = performance.now() - checkingAt
        metrics.job('verification', result, durationMs / 1000)
        log.debug('torrent.verification.completed', { durationMs, outcome: result })
      }
    }
    log.info('torrent.ready', { cacheClass: saved ? 'warm' : 'cold' })
    if (!saved) {
      fs.mkdir(path.dirname(metaFile), { recursive: true })
        .then(() => fs.writeFile(metaFile, torrent.torrentFile))
        .catch((err: unknown) => logger.error('torrent.metadata.save.failed', { err }))
    }
    // Remember the files' mtimes so a later load can trust the cached data without re-hashing
    torrent.getFileModtimes((err, modtimes) => {
      if (err || !modtimes) return
      fs.mkdir(folder, { recursive: true })
        .then(() => fs.writeFile(modtimesFile, JSON.stringify(modtimes)))
        .catch((writeErr: unknown) => logger.error('torrent.modtimes.save.failed', { err: writeErr }))
    })
    seed(torrent)
    return handle(torrent)
  }

  async function add (id: string | Uint8Array, context?: OperationContext): Promise<Torrent> {
    const parsed = await parseId(id)
    const ih = parsed.infoHash
    touch(ih)

    const existing = find(ih)
    if (existing?.ready) return handle(existing)
    const waiting = pending.get(ih)
    if (waiting) { context?.logger.info('torrent.job.joined', { jobId: jobIds.get(ih) }); return waiting }
    // Publish the whole initialization job before its first filesystem await.
    // Player title/probe requests often arrive together on a cold cache.
    const jobId = randomUUID()
    jobIds.set(ih, jobId)
    const job = observeJob(logger, metrics, 'torrent', async log => await runLoad(() => load(ih, parsed, existing, log)), { jobId, torrentId: ih }, context, () => stopping)
    pending.set(ih, job)
    try {
      return await job
    } finally {
      if (pending.get(ih) === job) { pending.delete(ih); jobIds.delete(ih) }
    }
  }

  async function get (ih: string, context?: OperationContext): Promise<Torrent> {
    if (!INFO_HASH.test(ih)) throw new InvalidTorrentError('Bad info hash')
    const loaded = find(ih)
    const torrent = loaded?.ready ? handle(loaded) : await add(ih, context)
    touch(ih)
    return torrent
  }

  async function housekeeping (): Promise<void> {
    const { idleMs, cacheMaxBytes, seeding } = live()
    // -1 turns the throttle off (0 would stop uploads), so an idle server gives back freely
    client.throttleUpload(seeding.enabled && openStreams.size ? PLAYBACK_UPLOAD_BYTES_PER_SEC : -1)
    await Promise.all(client.torrents.map(saveUploaded))

    if (!seeding.enabled) {
      // Torrents being watched stay loaded and fall back to the playback idle timeout
      for (const t of client.torrents.filter(t => seeded.has(t.infoHash))) {
        seeded.delete(t.infoHash)
        if (!busy(t.infoHash)) await unload(t, 'seeding-disabled')
      }
    } else {
      for (const t of client.torrents) seed(t)
      const now = Date.now()
      for (const t of client.torrents.filter(t => seeded.has(t.infoHash))) {
        const ih = t.infoHash
        if (ratioReached(t)) {
          seeded.delete(ih)
          if (!busy(ih)) await unload(t, 'seeding-ratio')
        } else if (t.numPeers || t.uploadSpeed) {
          seeded.set(ih, now)
        } else if (!busy(ih) && now - Math.max(seeded.get(ih) ?? 0, lastUsed.get(ih) ?? 0) > SEED_IDLE_MS) {
          await unload(t, 'seeding-idle')
        }
      }
      // Oldest first; the cap stays soft while the extras are being watched
      let extra = seeded.size - MAX_SEEDED
      for (const ih of [...seeded.keys()]) {
        if (extra <= 0) break
        const t = find(ih)
        if (!t || busy(ih)) continue
        await unload(t, 'seeding-cap')
        extra--
      }
    }

    for (const t of [...client.torrents]) {
      if (seeded.has(t.infoHash)) continue
      const idle = Date.now() - (lastUsed.get(t.infoHash) ?? 0) > idleMs
      if (idle && !busy(t.infoHash)) await unload(t, 'idle')
    }
    await evict(dir, cacheMaxBytes, {
      // Streams, pending loads and loaded torrents that aren't seeded keep their folders
      inUse: name => busy(name) || (!!find(name) && !seeded.has(name)),
      seeded: name => seeded.has(name),
      unload: async name => {
        const t = find(name)
        if (t) await unload(t, 'evicted')
      },
    }, logger)
  }

  let housekeepingRunning = false
  const timer = setInterval(() => {
    if (housekeepingRunning) return
    housekeepingRunning = true
    housekeeping()
      .catch((err: unknown) => logger.error('cache.housekeeping.failed', { err }))
      .finally(() => { housekeepingRunning = false })
  }, housekeepingMs)
  timer.unref()

  let closing: Promise<void> | null = null

  function describe (torrent: TorrentLike & { infoHash: string }): TorrentInfo {
    const files = listFiles(torrent)
    const warning = contentWarning(files)
    warnings.delete(torrent.infoHash)
    if (warning) warnings.set(torrent.infoHash, warning)
    if (warnings.size > 5000) warnings.delete(warnings.keys().next().value!)
    return { infoHash: torrent.infoHash, name: torrent.name, files, warning }
  }

  return {
    async info (id) {
      const { infoHash } = await parseId(id)
      touch(infoHash)
      const loaded = find(infoHash)
      if (loaded?.ready) return describe(handle(loaded))
      const saved = await fs.readFile(path.join(dir, infoHash, 'meta.torrent'))
        .then(bytes => parseTorrent(bytes)).catch(() => null)
      if (saved?.infoHash === infoHash && saved.files) {
        return describe({ infoHash, name: saved.name ?? infoHash, files: saved.files })
      }
      return describe(await add(id))
    },
    add,
    get,
    async file (ih, idx, context) {
      const file = (await get(ih, context)).files[idx]
      if (!file) throw new NoSuchFileError('No such file in this torrent')
      return file
    },
    describe,
    knownWarning: ih => warnings.get(ih) ?? null,
    status (ih, { idx } = {}) {
      const t = find(ih)
      if (!t?.ready) return { loaded: false }
      const watched = idx !== undefined && !!t.files[idx]
      if (watched) touch(ih)
      return activity(t, openStreams.get(ih) ?? 0, watched ? idx : undefined)
    },
    recent: (limit = 20) => listCached(dir, limit, ih => lastUsed.get(ih) ?? 0),
    openStream (ih) {
      openStreams.set(ih, (openStreams.get(ih) ?? 0) + 1)
      let open = true
      return () => {
        if (!open) return
        open = false
        const remaining = (openStreams.get(ih) || 1) - 1
        if (remaining) openStreams.set(ih, remaining)
        else openStreams.delete(ih)
        touch(ih)
      }
    },
    stats: () => ({
      loads: runLoad.stats(),
      loaded: client.torrents.length,
      seeded: seeded.size,
      uploadSpeed: client.torrents.reduce((sum, t) => sum + t.uploadSpeed, 0),
    }),
    async cacheBytes () {
      const names = await fs.readdir(dir).catch(() => [])
      let total = 0
      for (const name of names) total += await dirBytes(path.join(dir, name))
      return total
    },
    housekeeping,
    close () {
      stopping = true
      clearInterval(timer)
      closing ??= Promise.all(client.torrents.map(saveUploaded)).then(() => new Promise<void>(resolve => {
        client.destroy(err => {
          if (err) logger.error('torrent.close.failed', { err })
          resolve()
        })
      }))
      return closing
    },
  }
}
