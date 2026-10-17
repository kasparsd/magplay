import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import fs from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import WebTorrent from 'webtorrent'
import { Server as Tracker } from 'bittorrent-tracker'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function port () {
  const server = net.createServer().listen(0, '127.0.0.1')
  await once(server, 'listening')
  const n = server.address().port
  await new Promise(resolve => server.close(resolve))
  return n
}
async function until (check, message) {
  for (let i = 0; i < 200; i++) {
    if (await check()) return
    await sleep(50)
  }
  throw new Error(message)
}

test('loopback peers: uncached bytes, disappearing seeder, cancellation, retry and dead metadata', { timeout: 60_000 }, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'magplay-peers-'))
  const tracker = new Tracker({ http: true, udp: false, ws: false, stats: false, interval: 1000 })
  tracker.on('warning', () => {})
  tracker.listen(0, '127.0.0.1')
  await once(tracker, 'listening')
  const announce = `http://127.0.0.1:${tracker.http.address().port}/announce`
  const seeder = new WebTorrent({ dht: false, lsd: false, natUpnp: false, natPmp: false, utp: false, torrentPort: 0 })
  seeder.on('error', err => assert.fail(err.message))
  let proc
  let logs = ''
  t.after(async () => {
    if (proc && proc.exitCode === null) {
      const exited = once(proc, 'exit')
      proc.kill('SIGTERM')
      await exited
    }
    await new Promise(resolve => seeder.destroy(resolve))
    await new Promise(resolve => tracker.close(resolve))
    await fs.rm(dir, { recursive: true, force: true })
  })
  const data = Buffer.alloc(8 * 1024 ** 2)
  for (let i = 0; i < data.length; i++) data[i] = i % 251
  const source = path.join(dir, 'original.bin')
  await fs.writeFile(source, data)
  const seed = file => new Promise(resolve => seeder.seed(file, { announce: [announce], private: true }, resolve))
  const first = await seed(source)
  const cache = path.join(dir, 'cache')
  const appPort = await port()
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(TORZNAB_|JACKETT_|PROWLARR_|BITMAGNET_|EXTRA_TRACKERS)/.test(key)))
  proc = spawn(process.execPath, ['src/server.js'], {
    env: {
      ...env,
      CACHE_DIR: cache,
      PORT: String(appPort),
      TORRENT_PORT: '0',
      EXTRA_TRACKERS: '',
      DHT_ENABLED: 'false',
      LSD_ENABLED: 'false',
      METADATA_TIMEOUT_S: '2'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  proc.stdout.on('data', b => { logs += b })
  proc.stderr.on('data', b => { logs += b })
  const origin = `http://127.0.0.1:${appPort}`
  const request = (url, options = {}) => fetch(origin + url, { signal: AbortSignal.timeout(15_000), ...options })
  const add = magnet => request('/api/torrents', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ magnet }) })
  const status = ih => request(`/api/torrents/${ih}/status?idx=0`).then(r => r.json())
  await until(() => request('/health').then(r => r.ok, () => false), `Server did not start: ${logs}`)

  await t.test('magnet metadata and missing byte ranges arrive from a TCP loopback peer', async () => {
    const added = await add(first.magnetURI)
    assert.equal(added.status, 200, await added.clone().text())
    const torrent = await added.json()
    assert.equal(torrent.infoHash, first.infoHash)
    const range = await request(`/raw/${first.infoHash}/0`, { headers: { Range: 'bytes=12345-23456' } })
    assert.equal(range.status, 206)
    assert.deepEqual(Buffer.from(await range.arrayBuffer()), data.subarray(12345, 23457))
    const whole = await request(`/raw/${first.infoHash}/0`)
    assert.deepEqual(createHash('sha256').update(Buffer.from(await whole.arrayBuffer())).digest(), createHash('sha256').update(data).digest())
    const stats = await status(first.infoHash)
    assert.ok(stats.downloaded > 0)
    await until(async () => (await status(first.infoHash)).file.progress === 1, 'download did not reach completion')
  })

  await t.test('client cancellation releases a stalled reader; a returning peer can serve a new request', async () => {
    const delayedPath = path.join(dir, 'delayed.bin')
    await fs.writeFile(delayedPath, data)
    const delayed = await seed(delayedPath)
    const magnet = delayed.magnetURI
    const ih = delayed.infoHash
    assert.equal((await add(magnet)).status, 200)
    await new Promise(resolve => seeder.remove(ih, resolve))
    assert.ok((await status(ih)).file.progress < 1, 'file must not be cached for the stalled-read test')
    for (const url of [`/raw/${ih}/0`, `/tar/${ih}`]) {
      const controller = new AbortController()
      const waiting = request(url, { signal: controller.signal }).then(res => res.arrayBuffer())
      const rejected = assert.rejects(waiting, err => err.name === 'AbortError')
      await until(async () => (await status(ih)).activeStreams === 1, 'media stream did not start')
      assert.equal((await request('/health')).status, 200)
      controller.abort()
      await rejected
      await until(async () => (await status(ih)).activeStreams === 0, 'cancelled reader kept its torrent stream open')
    }
    const returned = await seed(delayedPath)
    assert.equal(returned.infoHash, ih)
    const response = await request(`/raw/${ih}/0`)
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), data)
  })

  await t.test('a dead swarm times out without blocking health and can be retried', async () => {
    const magnet = `magnet:?xt=urn:btih:${'c'.repeat(40)}&tr=${encodeURIComponent(announce)}`
    for (let i = 0; i < 2; i++) {
      const pending = add(magnet)
      assert.equal((await request('/health')).status, 200)
      const response = await pending
      assert.equal(response.status, 504)
      assert.match((await response.json()).error, /No peers found/)
    }
  })
})
