import { noopLogger } from '@magplay/observability'
import type { Logger } from '@magplay/observability'
// The torrent cache on disk: one folder per info hash with the data and a saved meta.torrent.
import fs from 'node:fs/promises'
import path from 'node:path'
import parseTorrent from 'parse-torrent'

export interface RecentTorrent {
  infoHash: string
  name: string | null
  /** Bytes, from the metadata. */
  length: number | null
  /** ms; the folder's mtime or the last use since startup, whichever is later. */
  lastUsed: number
  /** Bytes on the server (torrent files are sparse). */
  onDisk: number
}

const INFO_HASH = /^[a-f0-9]{40}$/

/** Bytes a folder takes on disk: `blocks` counts what's actually allocated. */
export async function dirBytes (dir: string): Promise<number> {
  let total = 0
  for (const entry of await fs.readdir(dir, { recursive: true, withFileTypes: true }).catch(() => [])) {
    if (entry.isFile()) total += await fs.stat(path.join(entry.parentPath, entry.name)).then(s => s.blocks * 512, () => 0)
  }
  return total
}

/** Torrents with metadata in the cache, most recently used first. */
export async function listCached (dir: string, limit: number, lastUsed: (infoHash: string) => number): Promise<RecentTorrent[]> {
  const names = (await fs.readdir(dir).catch(() => [])).filter(n => INFO_HASH.test(n))
  const entries = await Promise.all(names.map(async ih => {
    const folder = path.join(dir, ih)
    const [meta, stat] = await Promise.all([fs.readFile(path.join(folder, 'meta.torrent')).catch(() => null), fs.stat(folder).catch(() => null)])
    if (!meta || !stat) return null
    const parsed = await parseTorrent(meta).catch(() => null)
    return parsed && { infoHash: ih, name: parsed.name ?? null, length: parsed.length ?? null, lastUsed: Math.max(stat.mtimeMs, lastUsed(ih)), folder }
  }))
  const list = entries.filter(e => e !== null).sort((a, b) => b.lastUsed - a.lastUsed).slice(0, limit)
  // How much is on the server; the folder holds the data and the metadata file
  return Promise.all(list.map(async ({ folder, ...e }) => {
    const bytes = await dirBytes(folder)
    return { ...e, onDisk: e.length === null ? bytes : Math.min(e.length, bytes) }
  }))
}

export interface EvictPolicy {
  /** Folders that are never deleted. */
  inUse: (name: string) => boolean
  /** Seeded folders go after every other folder, oldest first, and are unloaded before deletion. */
  seeded?: (name: string) => boolean
  unload?: (name: string) => Promise<void>
}

/** Deletes least-recently-used folders until the cache fits in `maxBytes`, skipping those in use and seeded ones last. */
export async function evict (dir: string, maxBytes: number, { inUse, seeded = () => false, unload }: EvictPolicy, logger: Logger = noopLogger): Promise<void> {
  const names = await fs.readdir(dir).catch(() => [])
  const dirs = await Promise.all(names.map(async name => {
    const folder = path.join(dir, name)
    const stat = await fs.stat(folder).catch(() => null)
    return { name, folder, mtime: stat?.mtimeMs ?? 0, bytes: await dirBytes(folder), seeded: seeded(name) }
  }))
  let total = dirs.reduce((sum, d) => sum + d.bytes, 0)
  for (const d of dirs.sort((a, b) => Number(a.seeded) - Number(b.seeded) || a.mtime - b.mtime)) {
    if (total <= maxBytes) break
    if (inUse(d.name)) continue
    if (d.seeded) await unload?.(d.name)
    logger.info('cache.evicted', { torrentId: /^[a-f0-9]{40}$/.test(d.name) ? d.name : undefined, bytes: d.bytes })
    await fs.rm(d.folder, { recursive: true, force: true })
    total -= d.bytes
  }
}
