import { serveFile } from './http-cache.js'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import config, { httpError } from './config.js'
import { busyError } from './limits.js'
import { ffmpegArgs } from './media.js'

const hlsDir = path.join(config.cacheDir, 'hls')
const IDLE_MS = 45_000
// Pause ffmpeg when it's this far ahead of the player, so the disk isn't filled with segments nobody watches yet
const AHEAD_PAUSE_S = 240
const AHEAD_RESUME_S = 120

/** @type {Map<string, any>} */
const sessions = new Map()
const byTab = new Map() // browser tab id -> session id
const closedTabs = new Map() // short-lived fence for a page closed before its POST arrives

fs.rmSync(hlsDir, { recursive: true, force: true }) // leftovers from a previous run
try {
  fs.mkdirSync(hlsDir, { recursive: true })
} catch (err) {
  console.error(`Cannot create the cache directory ${hlsDir} (${err.message}). Set CACHE_DIR to a writable location, e.g. CACHE_DIR=./data`)
  process.exit(1)
}

export function startSession ({ ih, idx, info, audio, start, mode, tab }, { spawnProcess = spawn } = {}) {
  if ((closedTabs.get(tab) || 0) > Date.now()) throw httpError(409, 'This player was closed. Open the file again.')
  const replacing = tab && byTab.get(tab)
  const admitted = [...sessions.values()].filter(s => !s.failure && s.id !== replacing)
  if (admitted.length >= config.maxHlsSessions) {
    throw busyError('Too many HLS players. Close another player or use an external player.')
  }
  const disk = fs.statfsSync(hlsDir)
  if (disk.bavail * disk.bsize < config.minFreeBytes) throw busyError('Not enough free disk space for HLS playback. Free space or use an external player.')
  const used = [...sessions.values()].reduce((sum, s) => sum + (s.bytes || 0), 0)
  if (used >= config.hlsMaxBytes) throw busyError('HLS storage is full. Close another player or use an external player.')
  stopTab(tab)
  const id = randomBytes(8).toString('hex')
  const dir = path.join(hlsDir, id)
  fs.mkdirSync(dir)
  const args = ffmpegArgs({ ih, idx, info, audio, start, mode, dir })
  const proc = spawnProcess(config.ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] })
  const s = { id, ih, idx, mode, start, dir, proc, tab, lastSeen: Date.now(), outTime: 0, speed: null, position: 0, paused: false, exitCode: null, stderr: [] }
  sessions.set(id, s)
  if (tab) byTab.set(tab, id)

  let buf = ''
  proc.stdout.on('data', chunk => {
    buf += chunk
    const lines = buf.split('\n')
    buf = lines.pop()
    for (const line of lines) {
      const [key, value] = line.split('=')
      if ((key === 'out_time_us' || key === 'out_time_ms') && Number(value) >= 0) s.outTime = Number(value) / 1e6
      if (key === 'speed' && parseFloat(value)) s.speed = parseFloat(value)
      if (key === 'progress') throttle(s)
    }
  })
  proc.stderr.on('data', chunk => {
    s.stderr.push(...String(chunk).trim().split('\n'))
    s.stderr.splice(0, s.stderr.length - 20)
  })
  proc.on('error', err => {
    s.exitCode = 'spawn-error'
    s.stderr.push(`Could not start ffmpeg: ${err.message}`)
    console.error(`[ffmpeg] ${id}: ${s.stderr.at(-1)}`)
  })
  proc.on('exit', (code, signal) => {
    if (s.exitCode === null) s.exitCode = code ?? signal
    console.log(`[ffmpeg] ${id} ${mode} exited ${code ?? signal}, speed ${s.speed ?? '?'}x, produced ${s.outTime.toFixed(0)} s` +
      (code ? `: ${s.stderr.slice(-1)[0] ?? ''}` : ''))
  })
  return s
}

export const getSession = id => sessions.get(id)

/** Marks a session as alive; `position` is the player's time within the session output. */
export function touchSession (id, position) {
  const s = sessions.get(id)
  if (!s) return null
  s.lastSeen = Date.now()
  if (Number.isFinite(position) && position >= 0) s.position = Math.min(position, s.outTime)
  throttle(s)
  return s
}

function throttle (s) {
  if (s.exitCode !== null) return
  const ahead = s.outTime - s.position
  if (!s.paused && ahead > AHEAD_PAUSE_S) { s.proc.kill('SIGSTOP'); s.paused = true }
  if (s.paused && ahead < AHEAD_RESUME_S) { s.proc.kill('SIGCONT'); s.paused = false }
}

export function sessionStats (s) {
  return {
    id: s.id,
    mode: s.mode,
    speed: s.speed,
    produced: s.outTime,
    paused: s.paused,
    running: s.exitCode === null,
    failed: s.exitCode !== null && s.exitCode !== 0,
    error: s.failure || (s.exitCode ? s.stderr.slice(-3).join('\n') : null),
  }
}

export function stopSession (id) {
  const s = sessions.get(id)
  if (!s) return
  sessions.delete(id)
  if (byTab.get(s.tab) === id) byTab.delete(s.tab)
  if (s.exitCode === null) {
    if (s.paused) s.proc.kill('SIGCONT')
    s.proc.kill('SIGKILL')
  }
  fs.rm(s.dir, { recursive: true, force: true }, () => {})
}

export function stopTab (tab) {
  if (tab && byTab.has(tab)) stopSession(byTab.get(tab))
}

/** Close a document activation, including a playback POST whose result is not known yet. */
export function closeTab (tab) {
  if (!/^[\w-]{1,64}$/.test(tab)) throw httpError(400, 'Invalid player tab')
  stopTab(tab)
  for (const [key, expires] of closedTabs) if (expires < Date.now()) closedTabs.delete(key)
  closedTabs.set(tab, Date.now() + 180_000)
  if (closedTabs.size > 1000) closedTabs.delete(closedTabs.keys().next().value)
}

setInterval(() => {
  for (const s of sessions.values()) if (Date.now() - s.lastSeen > IDLE_MS) stopSession(s.id)
}, 10_000).unref()

async function sessionBytes (s) {
  s.sizes ??= new Map()
  const entries = await fs.promises.readdir(s.dir, { withFileTypes: true }).catch(err => {
    if (err.code === 'ENOENT') return []
    throw err
  })
  const present = new Set()
  await Promise.all(entries.filter(e => e.isFile()).map(async e => {
    present.add(e.name)
    // Published segments never change. Only new segments, init, VTT and growing
    // temporary files need stat calls on subsequent checks.
    if (e.name.endsWith('.m4s') && s.sizes.has(e.name)) return
    const stat = await fs.promises.stat(path.join(s.dir, e.name)).catch(err => {
      if (err.code === 'ENOENT') return null // ffmpeg just renamed/deleted it
      throw err
    })
    s.sizes.set(e.name, stat?.size || 0)
  }))
  for (const name of s.sizes.keys()) if (!present.has(name)) s.sizes.delete(name)
  return [...s.sizes.values()].reduce((sum, n) => sum + n, 0)
}

let resourceCheck = null
/** Soft disk budget: stop producers and reclaim their output, never evict torrent data. */
export function checkSessionResources () {
  if (resourceCheck) return resourceCheck
  resourceCheck = (async () => {
    const all = [...sessions.values()].filter(s => !s.failure)
    if (!all.length) return
    await Promise.all(all.map(async s => { s.bytes = await sessionBytes(s) }))
    const disk = await fs.promises.statfs(hlsDir)
    const total = all.reduce((sum, s) => sum + s.bytes, 0)
    let reclaim = Math.max(total - config.hlsMaxBytes, config.minFreeBytes - disk.bavail * disk.bsize)
    if (reclaim <= 0) return
    // Largest output first; retain the failed session record so status polling
    // reports a useful error instead of silently forgetting the player's work.
    for (const s of all.sort((a, b) => b.bytes - a.bytes)) {
      if (reclaim <= 0) break
      if (!sessions.has(s.id)) continue
      if (s.exitCode === null) {
        if (s.paused) s.proc.kill('SIGCONT')
        s.proc.kill('SIGKILL')
      }
      s.failure = 'HLS disk limit reached. Free space or use an external player, then retry.'
      s.exitCode = 'resource-limit'
      s.paused = false
      await fs.promises.rm(s.dir, { recursive: true, force: true })
      reclaim -= s.bytes
      s.bytes = 0
      s.sizes.clear()
    }
  })().finally(() => { resourceCheck = null })
  return resourceCheck
}
setInterval(() => {
  checkSessionResources().catch(err => console.error('[hls] resource check:', err.message))
}, 2000).unref()

/** GET /hls/:id/:file: playlist, init segment and media segments. */
export async function serveHls (res, id, file, req) {
  const s = touchSession(id)
  if (!s || !/^[\w-]+\.(m3u8|mp4|m4s|vtt)$/.test(file)) {
    res.writeHead(404, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' })
    return res.end('No such session or file')
  }
  const types = { m3u8: 'application/vnd.apple.mpegurl', mp4: 'video/mp4', m4s: 'video/iso.segment', vtt: 'text/vtt' }
  // ffmpeg publishes .m4s via atomic rename (temp_file). Revalidate to honor session cleanup.
  if (file.endsWith('.m4s')) return serveFile(req, res, path.join(s.dir, file), types.m4s, 'private, no-cache')
  const stream = fs.createReadStream(path.join(s.dir, file))
  stream.on('error', () => {
    // Not written yet; tell the player whether to keep waiting
    if (res.headersSent) return res.destroy()
    res.writeHead(s.exitCode ? 500 : 404, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' })
    res.end(s.exitCode ? `ffmpeg failed: ${s.stderr.slice(-1)[0] ?? 'unknown error'}` : 'Not ready yet')
  })
  res.on('close', () => stream.destroy())
  stream.on('open', () => {
    res.writeHead(200, { 'Content-Type': types[file.split('.').pop()], 'Cache-Control': 'no-store' })
    if (req.method === 'HEAD') { stream.destroy(); res.end() } else stream.pipe(res)
  })
}

// Paused (SIGSTOPped) ffmpegs would outlive us, so kill them on shutdown
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    for (const id of sessions.keys()) stopSession(id)
    process.exit(0)
  })
}
