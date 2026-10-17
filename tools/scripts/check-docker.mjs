// Isolated smoke acceptance, never starts/reconfigures the user's Compose stack.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { prepareCachedMedia } from '../../tests/fixtures/media.js'

const exec = promisify(execFile)
const docker = async (...args) => (await exec('docker', args, { timeout: 120_000, maxBuffer: 1024 ** 2 })).stdout.trim()
const image = process.argv[2] || 'magplay:local-acceptance'
const name = `magplay-check-${process.pid}`
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'magplay-docker-'))
const report = { image, checks: [], timingsMs: {}, device: 'local Docker host; not the NAS' }
let started = false
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
try {
  const { ih, files, cache } = await prepareCachedMedia(dir)
  report.platform = await docker('image', 'inspect', image, '--format', '{{.Os}}/{{.Architecture}}')
  await docker('run', '-d', '--name', name, '-p', '127.0.0.1::8080', '-e', 'EXTRA_TRACKERS=', '-e', 'TORRENT_PORT=0', '-e', 'DHT_ENABLED=false', '-e', 'LSD_ENABLED=false', image)
  started = true
  const port = (await docker('port', name, '8080/tcp')).split(':').at(-1)
  const origin = `http://127.0.0.1:${port}`
  const get = (url, options = {}) => fetch(origin + url, { ...options, signal: AbortSignal.timeout(30_000) })
  for (let i = 0; ; i++) {
    if (await get('/health').then(r => r.ok, () => false)) break
    if (i === 60) throw new Error('Container did not become healthy')
    await sleep(200)
  }
  assert.equal(await docker('inspect', name, '--format', '{{.Config.User}}'), 'node')
  assert.equal((await get('/lib/progress.js')).status, 200)
  assert.equal((await get('/lib/progress.test.js')).status, 404)
  const tests = await docker('exec', name, 'find', '/app/src', '/app/public', '-name', '*.test.js')
  assert.equal(tests, '', 'production image must exclude colocated tests')
  report.checks.push('health, non-root runtime, frontend modules and test-free image')
  await docker('cp', path.join(cache, 'torrents'), `${name}:/data/`)
  await docker('exec', '-u', 'root', name, 'chown', '-R', 'node:node', '/data/torrents')
  const directIdx = files['Playback.S01E01.mp4']
  const remuxIdx = files['Playback.S01E02.mkv']
  const probe = await get(`/api/probe/${ih}/${remuxIdx}`)
  assert.equal(probe.status, 200, await probe.text())
  const part = await get(`/raw/${ih}/${directIdx}`, { headers: { Range: 'bytes=0-1023' } })
  assert.equal(part.status, 206)
  assert.equal((await part.arrayBuffer()).byteLength, 1024)
  report.checks.push('cached torrent verification, ffprobe and raw byte range')
  const play = async (idx, start = 0) => {
    const response = await get('/api/play', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ih, idx, start, audio: 0, tab: 'docker-check', caps: { h264: true, aac: true } }) })
    assert.equal(response.status, 200, await response.clone().text())
    return response.json()
  }
  assert.equal((await play(directIdx)).mode, 'direct')
  report.checks.push('direct MP4 decision')
  for (const start of [0, 30]) {
    const at = performance.now()
    const decision = await play(remuxIdx, start)
    assert.equal(decision.mode, 'remux')
    assert.equal(decision.offset, start)
    let segment
    for (let i = 0; ; i++) {
      const response = await get(decision.url)
      const text = await response.text()
      if (response.ok) segment = text.split('\n').find(line => line.endsWith('.m4s'))
      if (segment) break
      if (i === 100 || response.status === 500) throw new Error(`HLS failed: ${text}`)
      await sleep(100)
    }
    const media = await get(`/hls/${decision.session}/${segment}`)
    assert.equal(media.status, 200)
    assert.ok((await media.arrayBuffer()).byteLength > 0)
    report.timingsMs[start ? 'seekTo30FirstSegment' : 'remuxFirstSegment'] = Math.round(performance.now() - at)
    await get(`/api/play/${decision.session}`, { method: 'DELETE' })
    assert.equal((await get(decision.url)).status, 404)
  }
  report.checks.push('AC3 remux, HLS bytes, restart at 30 seconds and session cleanup')
  report.resources = await docker('stats', '--no-stream', '--format', '{{.CPUPerc}} CPU; {{.MemUsage}}', name)
  console.log(JSON.stringify(report, null, 2))
} catch (err) {
  if (started) console.error(await docker('logs', name).catch(() => 'Container logs unavailable'))
  throw err
} finally {
  if (started) await docker('rm', '-f', name)
  await fs.rm(dir, { recursive: true, force: true })
}
