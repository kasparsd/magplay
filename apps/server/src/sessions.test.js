import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'magplay-sessions-'))
process.env.CACHE_DIR = dir
process.env.MAX_HLS_SESSIONS = '2'
const { startSession, stopSession, getSession, touchSession, sessionStats, checkSessionResources, closeTab, parseProcStat } = await import('./sessions.js')
const { default: config } = await import('./config.js')
after(() => fs.rm(dir, { recursive: true, force: true }))

const info = { video: { codec: 'h264' }, audio: [], subtitles: [] }
function session (tab, options = {}) {
  const proc = new EventEmitter()
  proc.pid = 4242
  proc.stdout = new PassThrough()
  proc.stderr = new PassThrough()
  const signals = []
  proc.kill = signal => { signals.push(signal); return true }
  const s = startSession({ ih: 'a'.repeat(40), idx: 0, info, audio: 0, start: 0, mode: 'remux', tab }, { spawnProcess: () => proc, ...options })
  return { s, proc, signals }
}

test('ffmpeg startup errors are reported instead of crashing the service', () => {
  const { s, proc } = session('error')
  proc.emit('error', new Error('spawn ffmpeg ENOENT'))
  assert.equal(sessionStats(s).failed, true)
  assert.equal(sessionStats(s).running, false)
  assert.match(sessionStats(s).error, /Could not start ffmpeg.*ENOENT/)
  stopSession(s.id)
})

test('sessions throttle ahead, resume and kill paused processes on cleanup', () => {
  const { s, proc, signals } = session('throttle')
  proc.stdout.write('out_time_us=300000000\nprogress=continue\n')
  assert.equal(s.paused, true)
  touchSession(s.id, -50)
  assert.equal(s.position, 0)
  touchSession(s.id, 200)
  assert.equal(s.paused, false)
  touchSession(s.id, 0)
  stopSession(s.id)
  assert.deepEqual(signals, ['SIGSTOP', 'SIGCONT', 'SIGSTOP', 'SIGCONT', 'SIGKILL'])
  assert.equal(getSession(s.id), undefined)
})

test('starting another session for the same tab stops the previous session', () => {
  const first = session('same-tab')
  const second = session('same-tab')
  assert.equal(getSession(first.s.id), undefined)
  assert.deepEqual(first.signals, ['SIGKILL'])
  assert.equal(getSession(second.s.id), second.s)
  stopSession(second.s.id)
})

test('session admission is bounded but a tab can replace its own session at capacity', t => {
  const first = session('one')
  const second = session('two')
  t.after(() => { stopSession(first.s.id); stopSession(second.s.id) })
  assert.throws(() => session('three'), { status: 503, retryAfter: 5 })
  const replacement = session('one')
  t.after(() => stopSession(replacement.s.id))
  assert.equal(getSession(first.s.id), undefined)
  assert.equal(getSession(second.s.id), second.s)
})

test('low disk reserve rejects admission without killing another player', t => {
  const first = session('existing')
  const reserve = config.minFreeBytes
  t.after(() => { config.minFreeBytes = reserve; stopSession(first.s.id) })
  config.minFreeBytes = Number.MAX_SAFE_INTEGER
  assert.throws(() => session('existing'), { status: 503 })
  assert.deepEqual(first.signals, [])
  assert.equal(getSession(first.s.id), first.s)
})

test('closing a tab fences late playback requests without blocking a fresh activation', t => {
  const first = session('closing')
  closeTab('closing')
  assert.equal(getSession(first.s.id), undefined)
  assert.throws(() => session('closing'), { status: 409 })
  const next = session('reactivated')
  t.after(() => stopSession(next.s.id))
  assert.equal(getSession(next.s.id), next.s)
  assert.throws(() => closeTab('x'.repeat(65)), { status: 400 })
})

test('disk budget stops the producer, removes HLS output and retains a useful failure', async t => {
  const { s, proc, signals } = session('budget')
  const budget = config.hlsMaxBytes
  t.after(() => { config.hlsMaxBytes = budget; stopSession(s.id) })
  config.hlsMaxBytes = 512
  await fs.writeFile(path.join(s.dir, 'seg_00000.m4s'), Buffer.alloc(1024))
  await checkSessionResources()
  assert.deepEqual(signals, ['SIGKILL'])
  assert.equal(sessionStats(s).failed, true)
  assert.match(sessionStats(s).error, /HLS disk limit reached/)
  await assert.rejects(fs.stat(s.dir), { code: 'ENOENT' })
  proc.emit('exit', null, 'SIGKILL')
  assert.match(sessionStats(s).error, /HLS disk limit reached/)
})

/** A /proc/<pid>/stat line whose command name holds spaces and parentheses, with the given utime and stime in ticks. */
const procStat = (utime, stime) => `4242 (ffmpeg (hls) x) S 1 4242 4242 0 -1 4194304 1200 0 0 0 ${utime} ${stime} 0 0 20 0 3 0 100 0 0`

test('/proc stat parsing counts fields after the command name', () => {
  assert.equal(parseProcStat(procStat(250, 50)), 3)
  assert.equal(parseProcStat('garbage'), null)
})

test('fps comes from -progress and cpu is the share of all cores between polls', t => {
  let text = procStat(0, 0)
  const pids = []
  const readCpu = pid => { pids.push(pid); return text == null ? null : parseProcStat(text) }
  const { s, proc } = session('cpu', { readCpu, cores: 4 })
  t.after(() => stopSession(s.id))
  proc.stdout.write('frame=240\nfps=47.92\nout_time_us=10000000\nspeed=2.0x\nprogress=continue\n')
  const start = s.cpuSample.at
  // 4 CPU seconds over 2 s of wall time on 4 cores: half the machine
  text = procStat(300, 100)
  let stats = sessionStats(s, start + 2000)
  assert.equal(stats.fps, 47.92)
  assert.equal(stats.cpu, 0.5)
  assert.deepEqual(pids, [4242])
  // The next poll measures only its own window: 1 CPU second in 2 s on 4 cores
  text = procStat(350, 150)
  assert.equal(sessionStats(s, start + 4000).cpu, 0.125)
  // A poll right after another repeats the last value instead of dividing by a tiny window
  text = procStat(400, 150)
  assert.equal(sessionStats(s, start + 4100).cpu, 0.125)
  // Without /proc (macOS) there is no reading
  text = null
  stats = sessionStats(s, start + 6000)
  assert.equal(stats.cpu, null)
  // A finished ffmpeg uses no CPU and has no pid to read
  proc.emit('exit', 0, null)
  assert.equal(sessionStats(s, start + 8000).cpu, null)
})

test('cpu is null where /proc does not exist', t => {
  const { s } = session('no-proc', { readCpu: () => null })
  t.after(() => stopSession(s.id))
  assert.equal(sessionStats(s).cpu, null)
  assert.equal(sessionStats(s).fps, null)
})
