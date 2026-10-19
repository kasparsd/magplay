import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import parseTorrent, { toTorrentFile } from 'parse-torrent'
import WebTorrent from 'webtorrent'
import { createTorrentEngine, DEFAULT_LIVE } from './engine.ts'
import type { LiveOptions, TorrentEngine } from './engine.ts'
import { InvalidTorrentError, NoSuchFileError } from './errors.ts'
import { dirBytes } from './store.ts'

const PIECE = 16384

/** A .torrent for `data` as one file, with real piece hashes, so data already on disk verifies without peers. */
async function torrentFor (name: string, data: Buffer): Promise<{ bytes: Uint8Array, infoHash: string }> {
  const hashes = []
  for (let i = 0; i < data.length; i += PIECE) hashes.push(createHash('sha1').update(data.subarray(i, i + PIECE)).digest())
  const bytes = toTorrentFile({ info: { name, length: data.length, 'piece length': PIECE, pieces: Buffer.concat(hashes) } })
  return { bytes, infoHash: (await parseTorrent(bytes)).infoHash }
}

async function setup (t: { after: (fn: () => Promise<void>) => void }, live = DEFAULT_LIVE): Promise<{ dir: string, engine: TorrentEngine }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'magplay-engine-'))
  const engine = createTorrentEngine({ dir, port: 0, dht: false, lsd: false, live: () => live })
  t.after(async () => {
    await engine.close()
    await fs.rm(dir, { recursive: true, force: true })
  })
  return { dir, engine }
}

const collect = async (chunks: AsyncIterable<Uint8Array>): Promise<Buffer> => {
  const out = []
  for await (const chunk of chunks) out.push(chunk)
  return Buffer.concat(out)
}

test('a torrent whose data is on disk loads without peers, reads byte ranges and saves its metadata', async t => {
  const { dir, engine } = await setup(t)
  const data = Buffer.alloc(3 * PIECE + 100)
  for (let i = 0; i < data.length; i++) data[i] = i % 251
  const { bytes, infoHash } = await torrentFor('sample.bin', data)
  await fs.mkdir(path.join(dir, infoHash))
  await fs.writeFile(path.join(dir, infoHash, 'sample.bin'), data)

  const torrent = await engine.add(bytes)
  assert.deepEqual(await engine.info(infoHash), engine.describe(torrent))
  assert.equal(torrent.infoHash, infoHash)
  assert.equal(engine.describe(torrent).files[0]?.name, 'sample.bin')
  const file = await engine.file(infoHash, 0)
  assert.equal(file.length, data.length)
  assert.deepEqual(await collect(file.read(PIECE - 10, PIECE + 9, AbortSignal.timeout(5000))), data.subarray(PIECE - 10, PIECE + 10))
  await assert.rejects(engine.file(infoHash, 1), NoSuchFileError)

  const status = engine.status(infoHash, { idx: 0 })
  assert.ok(status.loaded && status.file?.progress === 1 && status.activeStreams === 0)
  const done = engine.openStream(infoHash)
  assert.ok(engine.status(infoHash).loaded && engine.stats().loaded === 1)
  const streaming = engine.status(infoHash)
  assert.equal(streaming.loaded && streaming.activeStreams, 1)
  done()
  done() // releasing twice counts once
  const after = engine.status(infoHash)
  assert.equal(after.loaded && after.activeStreams, 0)

  // The metadata is saved, so recent() lists it and a restart needs no peers for it
  for (let i = 0; i < 50 && !(await fs.stat(path.join(dir, infoHash, 'meta.torrent')).catch(() => null)); i++) await new Promise(resolve => setTimeout(resolve, 10))
  const [recent] = await engine.recent()
  assert.equal(recent?.infoHash, infoHash)
  assert.equal(recent.name, 'sample.bin')
  assert.ok(recent.onDisk > 0 && recent.onDisk <= data.length)

  await engine.close()
  const restarted = createTorrentEngine({ dir, port: 0, dht: false, lsd: false })
  t.after(() => restarted.close())
  assert.deepEqual(await restarted.info(infoHash), engine.describe(torrent))
  assert.equal(restarted.stats().loaded, 0)
  const restored = await restarted.file(infoHash, 0)
  assert.deepEqual(await collect(restored.read(0, 9, AbortSignal.timeout(5000))), data.subarray(0, 10))
})

test('saved file lists are available without data, peers or a free initialization slot', async t => {
  const { dir, engine } = await setup(t, { ...DEFAULT_LIVE, maxLoads: 0 })
  const bytes = toTorrentFile({
    info: {
      name: 'Season',
      files: [
        { length: 100, path: ['Season.S01E02.mkv'] },
        { length: 100, path: ['Season.S01E01.mkv'] },
        { length: 100, path: ['notes.txt'] },
      ],
      'piece length': PIECE,
      pieces: Buffer.alloc(20),
    }
  })
  const { infoHash } = await parseTorrent(bytes)
  const folder = path.join(dir, infoHash)
  await fs.mkdir(folder)
  await fs.writeFile(path.join(folder, 'meta.torrent'), bytes)
  const info = await engine.info(infoHash)
  assert.equal(info.name, 'Season')
  assert.equal(info.warning, null)
  assert.deepEqual(info.files.map(f => [f.idx, f.name, f.size]), [
    [1, 'Season.S01E01.mkv', 100],
    [0, 'Season.S01E02.mkv', 100],
    [2, 'notes.txt', 100],
  ])
  assert.deepEqual(await engine.info(`magnet:?xt=urn:btih:${infoHash}`), info)
  assert.deepEqual(engine.status(infoHash), { loaded: false })
  assert.equal(engine.stats().loads.used, 0)
  assert.equal(engine.stats().loaded, 0)
})

test('uncached file lists still load and remember content warnings', async t => {
  const { dir, engine } = await setup(t)
  const { bytes, infoHash } = await torrentFor('notes.txt', Buffer.from('notes'))
  const info = await engine.info(bytes)
  assert.equal(info.infoHash, infoHash)
  assert.equal(info.warning, 'Download only · no video files')
  assert.equal(engine.knownWarning(infoHash), info.warning)
  assert.equal(engine.stats().loaded, 1)
  await assert.rejects(engine.info('../bad'), InvalidTorrentError)
  // Let WebTorrent's asynchronous file-stat callback finish before destroying it.
  for (let i = 0; i < 100; i++) {
    if (await fs.stat(path.join(dir, infoHash, 'modtimes.json')).catch(() => null)) break
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.ok(await fs.stat(path.join(dir, infoHash, 'modtimes.json')))
})

test('invalid ids and unknown torrents fail clearly; status never loads a torrent', async t => {
  const { engine } = await setup(t)
  await assert.rejects(engine.add('not a torrent'), InvalidTorrentError)
  await assert.rejects(engine.get('bad'), InvalidTorrentError)
  assert.deepEqual(engine.status('a'.repeat(40)), { loaded: false })
  assert.equal(engine.knownWarning('a'.repeat(40)), null)
  assert.deepEqual(engine.stats(), { loads: { used: 0, limit: DEFAULT_LIVE.maxLoads }, loaded: 0, seeded: 0, uploadSpeed: 0 })
})

const exists = (p: string): Promise<boolean> => fs.stat(p).then(() => true, () => false)
const tick = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 5))

/** Puts `data` on disk (only its first piece when `partial`) and loads it, waiting for the metadata files it writes. */
async function load (engine: TorrentEngine, dir: string, name: string, { partial = false, uploaded }: { partial?: boolean, uploaded?: number } = {}): Promise<{ infoHash: string, folder: string, length: number }> {
  const data = Buffer.alloc(3 * PIECE + 100, name)
  const { bytes, infoHash } = await torrentFor(name, data)
  const folder = path.join(dir, infoHash)
  await fs.mkdir(folder)
  await fs.writeFile(path.join(folder, name), partial ? Buffer.concat([data.subarray(0, PIECE), Buffer.alloc(data.length - PIECE)]) : data)
  if (uploaded !== undefined) await fs.writeFile(path.join(folder, 'seed.json'), JSON.stringify({ uploaded }))
  await engine.add(bytes)
  for (let i = 0; i < 100 && !(await exists(path.join(folder, 'modtimes.json')) && await exists(path.join(folder, 'meta.torrent'))); i++) await tick()
  return { infoHash, folder, length: data.length }
}

const seedingLive = (overrides: Partial<LiveOptions> = {}): LiveOptions => ({ ...DEFAULT_LIVE, seeding: { enabled: true, ratio: 1 }, ...overrides })

test('with seeding off, uploads are not throttled and completed torrents unload on the playback idle timeout', async t => {
  const throttle = t.mock.method(WebTorrent.prototype, 'throttleUpload')
  const { dir, engine } = await setup(t, { ...DEFAULT_LIVE, idleMs: 0 })
  const { folder } = await load(engine, dir, 'done.bin')
  assert.equal(engine.stats().seeded, 0)
  await tick()
  await engine.housekeeping()
  assert.equal(throttle.mock.calls.at(-1)?.arguments[0], -1)
  assert.equal(engine.stats().loaded, 0)
  assert.ok(await exists(folder))
})

test('a completed torrent keeps seeding past the playback idle timeout until seeding is turned off', async t => {
  const live = seedingLive({ idleMs: 0 })
  const { dir, engine } = await setup(t, live)
  const { folder } = await load(engine, dir, 'seed.bin')
  await tick()
  await engine.housekeeping()
  assert.deepEqual([engine.stats().loaded, engine.stats().seeded], [1, 1])

  live.seeding = { enabled: false, ratio: 1 }
  await engine.housekeeping()
  assert.deepEqual([engine.stats().loaded, engine.stats().seeded], [0, 0])
  assert.ok(await exists(folder))
})

test('reaching the ratio unloads the torrent, keeps its data and remembers the uploaded bytes', async t => {
  const live = seedingLive()
  const { dir, engine } = await setup(t, live)
  const half = (3 * PIECE + 100) / 2
  const { infoHash, folder } = await load(engine, dir, 'ratio.bin', { uploaded: half })
  assert.equal(engine.stats().seeded, 1)

  live.seeding = { enabled: true, ratio: 0.5 }
  await engine.housekeeping()
  assert.deepEqual([engine.stats().loaded, engine.stats().seeded], [0, 0])
  assert.ok(await exists(path.join(folder, 'ratio.bin')))
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(folder, 'seed.json'), 'utf8')), { uploaded: half })

  // A higher ratio lets the next load seed it again
  live.seeding = { enabled: true, ratio: 2 }
  const modtimes = path.join(folder, 'modtimes.json')
  const written = (await fs.stat(modtimes, { bigint: true })).mtimeNs
  await engine.get(infoHash)
  assert.equal(engine.stats().seeded, 1)
  for (let i = 0; i < 100 && (await fs.stat(modtimes, { bigint: true })).mtimeNs === written; i++) await tick()
})

test('a partially downloaded torrent is not seeded', async t => {
  const { dir, engine } = await setup(t, seedingLive({ idleMs: 0 }))
  await load(engine, dir, 'partial.bin', { partial: true })
  assert.equal(engine.stats().seeded, 0)
  await tick()
  await engine.housekeeping()
  assert.deepEqual([engine.stats().loaded, engine.stats().seeded], [0, 0])
})

test('the seeding cap and cache eviction never unload or delete a torrent with an open stream', async t => {
  const live = seedingLive()
  const { dir, engine } = await setup(t, live)
  const torrents = []
  for (const name of ['a.bin', 'b.bin', 'c.bin', 'd.bin']) torrents.push(await load(engine, dir, name))
  const [watched, oldest] = torrents
  const done = engine.openStream(watched!.infoHash)
  assert.equal(engine.stats().seeded, 4)

  await engine.housekeeping()
  assert.deepEqual([engine.stats().loaded, engine.stats().seeded], [3, 3])
  assert.equal(engine.status(watched!.infoHash).loaded, true)
  assert.equal(engine.status(oldest!.infoHash).loaded, false)
  for (const { folder } of torrents) assert.ok(await exists(folder))

  live.cacheMaxBytes = 1
  await engine.housekeeping()
  assert.deepEqual([engine.stats().loaded, engine.stats().seeded], [1, 1])
  assert.deepEqual(await fs.readdir(dir), [watched!.infoHash])
  done()
})

test('eviction removes other cached data before seeded data, and seeded data when still over the limit', async t => {
  const live = seedingLive()
  const { dir, engine } = await setup(t, live)
  const seededTorrent = await load(engine, dir, 'kept.bin')
  const other = path.join(dir, 'b'.repeat(40))
  await fs.mkdir(other)
  await fs.writeFile(path.join(other, 'data'), Buffer.alloc(65536, 1))
  // Plain LRU would delete the seeded folder first
  await fs.utimes(seededTorrent.folder, new Date(1000), new Date(1000))
  await fs.utimes(other, new Date(2000), new Date(2000))

  live.cacheMaxBytes = await dirBytes(seededTorrent.folder) + 4096
  await engine.housekeeping()
  assert.deepEqual(await fs.readdir(dir), [seededTorrent.infoHash])
  assert.equal(engine.stats().seeded, 1)

  live.cacheMaxBytes = 1
  await engine.housekeeping()
  assert.deepEqual(await fs.readdir(dir), [])
  assert.deepEqual([engine.stats().loaded, engine.stats().seeded], [0, 0])
})

test('while seeding, an open stream caps uploads at 128 KiB/s and no stream turns the throttle off', async t => {
  const throttle = t.mock.method(WebTorrent.prototype, 'throttleUpload')
  const { dir, engine } = await setup(t, seedingLive())
  const { infoHash } = await load(engine, dir, 'throttle.bin')
  await engine.housekeeping()
  assert.equal(throttle.mock.calls.at(-1)?.arguments[0], -1)
  const done = engine.openStream(infoHash)
  await engine.housekeeping()
  assert.equal(throttle.mock.calls.at(-1)?.arguments[0], 128 * 1024)
  done()
  await engine.housekeeping()
  assert.equal(throttle.mock.calls.at(-1)?.arguments[0], -1)
})

test('housekeeping evicts the least recently used folders above the cache limit', async t => {
  const { dir, engine } = await setup(t, { ...DEFAULT_LIVE, cacheMaxBytes: 1 })
  const old = path.join(dir, 'b'.repeat(40))
  const newer = path.join(dir, 'c'.repeat(40))
  for (const folder of [old, newer]) {
    await fs.mkdir(folder)
    await fs.writeFile(path.join(folder, 'data'), Buffer.alloc(8192, 1))
  }
  await fs.utimes(old, new Date(1000), new Date(1000))
  t.mock.method(console, 'log', () => {})
  await engine.housekeeping()
  assert.deepEqual(await fs.readdir(dir), [])
  assert.equal(await engine.cacheBytes(), 0)
})

test('close() releases the client once, however often it is called', async t => {
  const { engine } = await setup(t)
  const first = engine.close()
  assert.equal(engine.close(), first)
  await first
})
