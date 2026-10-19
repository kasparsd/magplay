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
export interface SeedingLiveOptions {
  enabled: boolean
  uploadSpeedLimitBytesPerSec: number
  maxTorrents: number
  idleMs: number
}

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
  /** Opt-in seeding of completed torrents. */
  seedingEnabled: boolean
  seedingUploadSpeedLimitBytesPerSec: number
  seedingMaxTorrents: number
  seedingIdleMs: number
  /** Nested form, kept in sync for callers that prefer it. */
  seeding: SeedingLiveOptions
}

export const DEFAULT_LIVE: LiveOptions = {
  maxLoads: 4,
  extraTrackers: [],
  metadataTimeoutMs: 60_000,
  checkingTimeoutMs: 7_200_000,
  idleMs: 30 * 60_000,
  cacheMaxBytes: 50 * 1024 ** 3,
  seedingEnabled: false,
  seedingUploadSpeedLimitBytesPerSec: 0,
  seedingMaxTorrents: 3,
  seedingIdleMs: 24 * 60 * 60_000,
  seeding: { enabled: false, uploadSpeedLimitBytesPerSec: 0, maxTorrents: 3, idleMs: 24 * 60 * 60_000 },
}

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
  /** Busy loading slots and loaded torrents, for the Debug page. */
  stats: () => { loads: { used: number, limit: number }, loaded: number }
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
  const seeded = new Set<string>() // infoHashes of completed torrents being seeded
  const seededAt = new Map<string, number>() // infoHash -> ms when seeding started
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

  function seedingOpts () {
    const l = live() as unknown as Record<string, unknown>
    const nested = (l.seeding ?? {}) as Record<string, unknown>
    const enabled = !!(l.seedingEnabled ?? nested.enabled)
    return {
      enabled,
      uploadSpeedLimitBytesPerSec: Number(l.seedingUploadSpeedLimitBytesPerSec ?? nested.uploadSpeedLimitBytesPerSec ?? 0),
      maxTorrents: Number(l.seedingMaxTorrents ?? nested.maxTorrents ?? 3),
      idleMs: Number(l.seedingIdleMs ?? nested.idleMs ?? 24 * 60 * 60_000),
    }
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
    if (saved && !existing) parsed = await parseTorrent(saved)
    const { extraTrackers, metadataTimeoutMs, checkingTimeoutMs } = live()
    parsed.announce = [...new Set([...(parsed.announce ?? []), ...extraTrackers])]
    const torrent = existing ?? client.add(parsed, { path: folder, deselect: true, ...(savedModtimes ? { fileModtimes: savedModtimes } : {}) })
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
    const markSeeded = (): void => {
      const so = seedingOpts()
      if (!so.enabled) return
      if (torrent.progress !== 1) return
      seeded.add(torrent.infoHash)
      seededAt.set(torrent.infoHash, seededAt.get(torrent.infoHash) ?? Date.now())
    }
    torrent.on('done', markSeeded)
    torrent.on('close', () => { seeded.delete(torrent.infoHash); seededAt.delete(torrent.infoHash) })
    if (torrent.done || torrent.progress === 1) markSeeded()
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
    const { idleMs, cacheMaxBytes } = live()
    const so = seedingOpts()
    // Apply the global upload throttle on every pass so setting changes take effect.
    client.throttleUpload(so.enabled ? so.uploadSpeedLimitBytesPerSec : 0)

    if (!so.enabled) {
      // Seeding disabled: unload any seeded torrents and forget them.
      for (const t of [...client.torrents]) {
        if (!seeded.has(t.infoHash)) continue
        if (openStreams.get(t.infoHash)) continue
        if (pending.has(t.infoHash)) continue
        logger.info('torrent.unloaded', { torrentId: t.infoHash, reason: 'seeding-disabled' })
        t.destroy()
        seeded.delete(t.infoHash)
        seededAt.delete(t.infoHash)
      }
    } else {
      // Enforce the soft cap on seeded torrents: skip those with open streams.
      const seededTorrents = client.torrents.filter(t => seeded.has(t.infoHash))
      if (seededTorrents.length > so.maxTorrents) {
        const candidates = seededTorrents
          .filter(t => !openStreams.get(t.infoHash) && !pending.has(t.infoHash))
          .sort((a, b) => (seededAt.get(a.infoHash) ?? 0) - (seededAt.get(b.infoHash) ?? 0))
        let count = seededTorrents.length
        for (const t of candidates) {
          if (count <= so.maxTorrents) break
          logger.info('torrent.unloaded', { torrentId: t.infoHash, reason: 'seeding-cap' })
          t.destroy()
          seeded.delete(t.infoHash)
          seededAt.delete(t.infoHash)
          count--
        }
      }
      // Fallback idle unload for seeded torrents with no peers and no upload.
      for (const t of [...client.torrents]) {
        if (!seeded.has(t.infoHash)) continue
        if (openStreams.get(t.infoHash) || pending.has(t.infoHash)) continue
        const peers = (t as { numPeers?: number }).numPeers ?? 0
        const uploading = t.uploadSpeed > 0
        if (peers === 0 && !uploading) {
          const idle = Date.now() - (lastUsed.get(t.infoHash) ?? seededAt.get(t.infoHash) ?? 0) > so.idleMs
          if (idle) {
            logger.info('torrent.unloaded', { torrentId: t.infoHash, reason: 'seeding-idle' })
            t.destroy()
            seeded.delete(t.infoHash)
            seededAt.delete(t.infoHash)
          }
        }
      }
    }

    // Normal idle unload for non-seeded torrents.
    for (const t of [...client.torrents]) {
      if (seeded.has(t.infoHash)) continue
      const idle = Date.now() - (lastUsed.get(t.infoHash) ?? 0) > idleMs
      if (idle && !openStreams.get(t.infoHash) && !pending.has(t.infoHash)) {
        logger.info('torrent.unloaded', { torrentId: t.infoHash, reason: 'idle' })
        t.destroy()
      }
    }
    await evict(dir, cacheMaxBytes, name => !!find(name), logger, {
      isSeeded: (name: string) => seeded.has(name),
      unload: async (name: string) => {
        const t = find(name)
        if (t) t.destroy()
        seeded.delete(name)
        seededAt.delete(name)
      },
    })
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
    stats: () => {
      const seededList = client.torrents.filter(t => seeded.has(t.infoHash))
      const uploadSpeed = client.torrents.reduce((sum, t) => sum + (t.uploadSpeed ?? 0), 0)
      return {
        loads: runLoad.stats(),
        loaded: client.torrents.length,
        seeded: seeded.size,
        seededCount: seeded.size,
        seeding: seeded.size,
        seededTorrents: seeded.size,
        uploadSpeed,
        totalUploadSpeed: uploadSpeed,
        seededUploadSpeed: seededList.reduce((sum, t) => sum + (t.uploadSpeed ?? 0), 0),
      }
    },
    async cacheBytes () {
      const names = await fs.readdir(dir).catch(() => [])
      let total = 0
      for (const name of names) total += await dirBytes(path.join(dir, name))
      return total
    },
    housekeeping,
    close () {
      stopping = true
      closing ??= new Promise<void>(resolve => {
        clearInterval(timer)
        client.destroy(err => {
          if (err) logger.error('torrent.close.failed', { err })
          resolve()
        })
      })
      return closing
    },
  }
}
