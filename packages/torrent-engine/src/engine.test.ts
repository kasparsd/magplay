import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import parseTorrent, { toTorrentFile } from 'parse-torrent'
import { createTorrentEngine, DEFAULT_LIVE } from './engine.ts'
import type { TorrentEngine } from './engine.ts'
import { InvalidTorrentError, NoSuchFileError } from './errors.ts'

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
  assert.deepEqual(engine.stats(), { loads: { used: 0, limit: DEFAULT_LIVE.maxLoads }, loaded: 0, seeded: 0, seededCount: 0, seeding: 0, seededTorrents: 0, uploadSpeed: 0, totalUploadSpeed: 0, seededUploadSpeed: 0 })
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
