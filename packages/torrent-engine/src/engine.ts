// The torrent engine: one WebTorrent client, a metadata store and cache on disk, deadlines for loading,
// idle unloading and size-based eviction. Created by createTorrentEngine() and released by close().
import fs from 'node:fs/promises'
import path from 'node:path'
import WebTorrent from 'webtorrent'
import type { Torrent as WtTorrent, TorrentFile as WtFile } from 'webtorrent'
import parseTorrent from 'parse-torrent'
import type { ParsedTorrent } from 'parse-torrent'
import { contentWarning, listFiles } from '@magplay/release-info'
import type { ListedFile } from '@magplay/release-info'
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
}

export const DEFAULT_LIVE: LiveOptions = {
  maxLoads: 4,
  extraTrackers: [],
  metadataTimeoutMs: 60_000,
  checkingTimeoutMs: 7_200_000,
  idleMs: 30 * 60_000,
  cacheMaxBytes: 50 * 1024 ** 3,
}

export interface TorrentEngineOptions {
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
  /** Adds (or reuses) a torrent by magnet, info hash or .torrent bytes and waits for its file list. Nothing is selected for download. */
  add: (id: string | Uint8Array) => Promise<Torrent>
  /** A loaded torrent, re-adding it by info hash if it was unloaded. */
  get: (infoHash: string) => Promise<Torrent>
  /** A file of a torrent, loading the torrent if needed. */
  file: (infoHash: string, idx: number) => Promise<TorrentFile>
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

export function createTorrentEngine ({ dir, port, dht, lsd, live = () => DEFAULT_LIVE, housekeepingMs = 60_000 }: TorrentEngineOptions): TorrentEngine {
  const runLoad = createLimiter(() => live().maxLoads, () => new EngineBusyError('Torrent initialization is busy. Try again shortly.'))
  const client = new WebTorrent({
    torrentPort: port,
    dhtPort: port,
    dht,
    lsd,
    natUpnp: false, // inside Docker; publish the port in Compose instead
    natPmp: false,
    utp: false, // uTP would bind the same UDP port as the DHT; peers connect over TCP
  })
  client.on('error', (err: Error) => console.error('[torrent] client error:', err.message))

  const lastUsed = new Map<string, number>() // infoHash -> ms
  const openStreams = new Map<string, number>() // infoHash -> number of open streams
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

  async function load (ih: string, parsed: ParsedTorrent, existing: WtTorrent | undefined): Promise<Torrent> {
    // Metadata saved on an earlier visit: no need to wait for peers to send it again
    const metaFile = path.join(dir, ih, 'meta.torrent')
    const saved = await fs.readFile(metaFile).catch(() => null)
    if (saved && !existing) parsed = await parseTorrent(saved)
    const { extraTrackers, metadataTimeoutMs, checkingTimeoutMs } = live()
    parsed.announce = [...new Set([...(parsed.announce ?? []), ...extraTrackers])]
    const torrent = existing ?? client.add(parsed, { path: path.join(dir, ih), deselect: true })
    await waitForTorrent(torrent, { metadataMs: metadataTimeoutMs, checkingMs: checkingTimeoutMs })
    if (!saved) {
      fs.mkdir(path.dirname(metaFile), { recursive: true })
        .then(() => fs.writeFile(metaFile, torrent.torrentFile))
        .catch((err: unknown) => console.error('[torrent] saving metadata:', err instanceof Error ? err.message : err))
    }
    return handle(torrent)
  }

  async function add (id: string | Uint8Array): Promise<Torrent> {
    let parsed: ParsedTorrent
    try {
      parsed = await parseTorrent(id)
    } catch {
      throw new InvalidTorrentError('Not a valid magnet, info hash or torrent file')
    }
    if (!parsed?.infoHash) throw new InvalidTorrentError('Not a valid magnet, info hash or torrent file')
    const ih = parsed.infoHash
    touch(ih)

    const existing = find(ih)
    if (existing?.ready) return handle(existing)
    const waiting = pending.get(ih)
    if (waiting) return waiting
    // Publish the whole initialization job before its first filesystem await.
    // Player title/probe requests often arrive together on a cold cache.
    const job = runLoad(() => load(ih, parsed, existing))
    pending.set(ih, job)
    try {
      return await job
    } finally {
      if (pending.get(ih) === job) pending.delete(ih)
    }
  }

  async function get (ih: string): Promise<Torrent> {
    if (!INFO_HASH.test(ih)) throw new InvalidTorrentError('Bad info hash')
    const loaded = find(ih)
    const torrent = loaded?.ready ? handle(loaded) : await add(ih)
    touch(ih)
    return torrent
  }

  async function housekeeping (): Promise<void> {
    const { idleMs, cacheMaxBytes } = live()
    for (const t of [...client.torrents]) {
      const idle = Date.now() - (lastUsed.get(t.infoHash) ?? 0) > idleMs
      if (idle && !openStreams.get(t.infoHash) && !pending.has(t.infoHash)) {
        console.log(`[torrent] unloading idle ${t.infoHash} ${t.name ?? ''}`)
        t.destroy()
      }
    }
    await evict(dir, cacheMaxBytes, name => !!find(name))
  }

  let housekeepingRunning = false
  const timer = setInterval(() => {
    if (housekeepingRunning) return
    housekeepingRunning = true
    housekeeping()
      .catch((err: unknown) => console.error('[cache]', err instanceof Error ? err.message : err))
      .finally(() => { housekeepingRunning = false })
  }, housekeepingMs)
  timer.unref()

  let closing: Promise<void> | null = null

  return {
    add,
    get,
    async file (ih, idx) {
      const file = (await get(ih)).files[idx]
      if (!file) throw new NoSuchFileError('No such file in this torrent')
      return file
    },
    describe (torrent) {
      const files = listFiles(torrent)
      const warning = contentWarning(files)
      warnings.delete(torrent.infoHash)
      if (warning) warnings.set(torrent.infoHash, warning)
      if (warnings.size > 5000) warnings.delete(warnings.keys().next().value!)
      return { infoHash: torrent.infoHash, name: torrent.name, files, warning }
    },
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
    stats: () => ({ loads: runLoad.stats(), loaded: client.torrents.length }),
    async cacheBytes () {
      const names = await fs.readdir(dir).catch(() => [])
      let total = 0
      for (const name of names) total += await dirBytes(path.join(dir, name))
      return total
    },
    housekeeping,
    close () {
      closing ??= new Promise<void>(resolve => {
        clearInterval(timer)
        client.destroy(err => {
          if (err) console.error('[torrent] closing:', err.message)
          resolve()
        })
      })
      return closing
    },
  }
}
