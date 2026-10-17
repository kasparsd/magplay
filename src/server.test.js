import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import net from 'node:net'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'

async function freePort () {
  const server = net.createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}

test('HTTP server serves pages and modules, rejects bad routes and remains healthy', { timeout: 20_000 }, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'magplay-http-'))
  const port = await freePort()
  const proc = spawn(process.execPath, ['src/server.js'], {
    env: {
      ...process.env,
      PORT: String(port),
      TORRENT_PORT: '0',
      CACHE_DIR: dir,
      TORZNAB_URL: 'http://127.0.0.1:1/feed',
      BITMAGNET_URL: '',
      JACKETT_URL: '',
      PROWLARR_URL: ''
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  proc.stdout.on('data', chunk => { output += chunk })
  proc.stderr.on('data', chunk => { output += chunk })
  t.after(async () => {
    if (proc.exitCode === null && proc.signalCode === null) {
      const exited = once(proc, 'exit')
      proc.kill('SIGTERM')
      await exited
    }
    await fs.rm(dir, { recursive: true, force: true })
  })
  const origin = `http://127.0.0.1:${port}`
  for (let i = 0; ; i++) {
    if (proc.exitCode !== null) assert.fail(`Server exited: ${output}`)
    if (await fetch(`${origin}/health`).then(r => r.ok, () => false)) break
    if (i >= 100) assert.fail(`Server did not start: ${output}`)
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  for (const url of ['/', '/explore', '/style.css', '/player.js', '/lib/requests.js', '/lib/api.js', '/lib/api-types.js', '/lib/capabilities.js', '/lib/subtitles.js', '/lib/progress.js', '/vendor/hls.min.js']) {
    const res = await fetch(origin + url)
    assert.equal(res.status, 200, url)
    assert.equal(res.headers.get('cache-control'), 'no-cache')
    const etag = res.headers.get('etag')
    assert.ok(etag)
    const length = res.headers.get('content-length')
    assert.ok((await res.text()).length > 0, url)
    const cached = await fetch(origin + url, { headers: { 'If-None-Match': `"old", ${etag.replace(/^W\//, '')}` } })
    assert.equal(cached.status, 304)
    assert.equal(await cached.text(), '')
    assert.equal(cached.headers.get('etag'), etag)
    const head = await fetch(origin + url, { method: 'HEAD' })
    assert.equal(head.status, 200)
    assert.equal(head.headers.get('content-length'), length)
    assert.equal(await head.text(), '')
  }
  for (const [url, status] of [['/t/%ZZ', 400], ['/playlistXm3u', 404], ['/api/search', 400], ['/api/torrents/bad', 400], ['/api/explore', 404], ['/lib/api.test.js', 404], ['/lib/requests.test.js', 404], ['/lib/capabilities.test.js', 404], ['/lib/subtitles.test.js', 404], ['/lib/progress.test.js', 404]]) {
    const res = await fetch(origin + url)
    assert.equal(res.status, status, url)
    assert.equal(res.headers.get('cache-control'), 'no-store')
    assert.equal(typeof (await res.json()).error, 'string')
  }
  for (const body of ['null', '[]', '"string"', '{', '{"caps":null}', '{"start":"Infinity"}', '{"audio":-1}']) {
    const res = await fetch(`${origin}/api/play`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
    assert.equal(res.status, 400, body)
    assert.equal(res.headers.get('cache-control'), 'no-store')
    assert.equal(typeof (await res.json()).error, 'string')
  }
  for (const url of ['/health', '/api/recent', '/hls/missing/index.m3u8', '/hls/missing/seg_00000.m4s']) {
    const res = await fetch(origin + url, { headers: { 'If-None-Match': '*' } })
    assert.notEqual(res.status, 304)
    assert.equal(res.headers.get('cache-control'), 'no-store')
  }
  const redirect = await fetch(origin + '/player.html?ih=abc&idx=0', { redirect: 'manual' })
  assert.equal(redirect.status, 301)
  assert.equal(redirect.headers.get('cache-control'), 'no-store')
  assert.deepEqual(await fetch(`${origin}/health`).then(r => r.json()), { ok: true })
})
