import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHlsSessions, DEFAULT_HLS_LIVE, parseProcStat } from './hls.ts'
import type { FfmpegProcess, HlsLive, HlsSessions, HlsSessionsOptions } from './hls.ts'
import { PlaybackBusyError } from './errors.ts'

const info = { video: { codec: 'h264' }, audio: [], subtitles: [] }

class FakeProcess extends EventEmitter {
  pid = 4242
  stdout = new PassThrough()
  stderr = new PassThrough()
  signals: string[] = []
  kill (signal?: NodeJS.Signals | number): boolean { this.signals.push(String(signal)); return true }
}

interface Setup { hls: HlsSessions, dir: string, live: HlsLive, start: (replaces?: string) => { s: ReturnType<HlsSessions['start']>, proc: FakeProcess } }

async function setup (t: { after: (fn: () => Promise<void>) => void }, options: Partial<HlsSessionsOptions> = {}): Promise<Setup> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'magplay-hls-'))
  const dir = path.join(root, 'hls')
  const live = { ...DEFAULT_HLS_LIVE, maxSessions: 2 }
  let proc = new FakeProcess()
  const hls = createHlsSessions({ dir, live: () => live, spawnProcess: () => proc as unknown as FfmpegProcess, ...options })
  t.after(async () => {
    await hls.close()
    await fs.rm(root, { recursive: true, force: true })
  })
  const start = (replaces?: string) => {
    proc = new FakeProcess()
    const current = proc
    return { s: hls.start({ input: 'http://127.0.0.1/raw/x/0', info, audio: 0, start: 0, mode: 'remux', replaces }), proc: current }
  }
  return { hls, dir, live, start }
}

test('the HLS folder is emptied at creation and close() stops every session and deletes its output', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'magplay-hls-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  await fs.mkdir(path.join(root, 'hls', 'stale'), { recursive: true })
  const proc = new FakeProcess()
  const hls = createHlsSessions({ dir: path.join(root, 'hls'), spawnProcess: () => proc as unknown as FfmpegProcess })
  assert.deepEqual(await fs.readdir(path.join(root, 'hls')), [])
  const s = hls.start({ input: 'x', info, audio: 0, start: 0, mode: 'remux' })
  proc.stdout.write('out_time_us=300000000\nprogress=continue\n') // far ahead: paused
  await hls.close()
  assert.deepEqual(proc.signals, ['SIGSTOP', 'SIGCONT', 'SIGKILL'])
  assert.equal(hls.get(s.id), undefined)
  assert.deepEqual(await fs.readdir(path.join(root, 'hls')), [])
})

test('ffmpeg startup errors are reported instead of crashing the service', async t => {
  const { hls, start } = await setup(t)
  const { s, proc } = start()
  t.mock.method(console, 'error', () => {})
  proc.emit('error', new Error('spawn ffmpeg ENOENT'))
  assert.equal(hls.stats(s).failed, true)
  assert.equal(hls.stats(s).running, false)
  assert.match(hls.stats(s).error ?? '', /Could not start ffmpeg.*ENOENT/)
})

test('sessions throttle ahead, resume and kill paused processes on cleanup', async t => {
  const stopped: string[] = []
  const { hls, start } = await setup(t, { onStop: id => stopped.push(id) })
  const { s, proc } = start()
  proc.stdout.write('out_time_us=300000000\nprogress=continue\n')
  assert.equal(s.paused, true)
  hls.touch(s.id, -50)
  assert.equal(s.position, 0)
  hls.touch(s.id, 200)
  assert.equal(s.paused, false)
  hls.touch(s.id, 0)
  hls.stop(s.id)
  assert.deepEqual(proc.signals, ['SIGSTOP', 'SIGCONT', 'SIGSTOP', 'SIGCONT', 'SIGKILL'])
  assert.equal(hls.get(s.id), undefined)
  assert.deepEqual(stopped, [s.id])
})

test('admission is bounded, but a session can be replaced at capacity', async t => {
  const { hls, start } = await setup(t)
  const first = start()
  const second = start()
  assert.throws(() => start(), PlaybackBusyError)
  const replacement = start(first.s.id)
  assert.equal(hls.get(first.s.id), undefined)
  assert.deepEqual(first.proc.signals, ['SIGKILL'])
  assert.equal(hls.get(second.s.id), second.s)
  assert.equal(hls.get(replacement.s.id), replacement.s)
  assert.deepEqual(hls.summary(), { active: 2, bytes: 0 })
})

test('a low disk reserve rejects admission without killing another player', async t => {
  const { hls, live, start } = await setup(t)
  const first = start()
  live.minFreeBytes = Number.MAX_SAFE_INTEGER
  assert.throws(() => start(first.s.id), PlaybackBusyError)
  assert.deepEqual(first.proc.signals, [])
  assert.equal(hls.get(first.s.id), first.s)
})

test('disk budget stops the producer, removes HLS output and retains a useful failure', async t => {
  const { hls, live, start } = await setup(t)
  const { s, proc } = start()
  live.hlsMaxBytes = 512
  await fs.writeFile(path.join(s.dir, 'seg_00000.m4s'), Buffer.alloc(1024))
  await hls.checkResources()
  assert.deepEqual(proc.signals, ['SIGKILL'])
  assert.equal(hls.stats(s).failed, true)
  assert.match(hls.stats(s).error ?? '', /HLS disk limit reached/)
  await assert.rejects(fs.stat(s.dir), { code: 'ENOENT' })
  t.mock.method(console, 'log', () => {})
  proc.emit('exit', null, 'SIGKILL')
  assert.match(hls.stats(s).error ?? '', /HLS disk limit reached/)
  assert.equal(hls.summary().active, 0)
})

/** A /proc/<pid>/stat line whose command name holds spaces and parentheses, with the given utime and stime in ticks. */
const procStat = (utime: number, stime: number) => `4242 (ffmpeg (hls) x) S 1 4242 4242 0 -1 4194304 1200 0 0 0 ${utime} ${stime} 0 0 20 0 3 0 100 0 0`

test('/proc stat parsing counts fields after the command name', () => {
  assert.equal(parseProcStat(procStat(250, 50)), 3)
  assert.equal(parseProcStat('garbage'), null)
})

test('fps comes from -progress and cpu is the share of all cores between polls', async t => {
  let text: string | null = procStat(0, 0)
  const pids: Array<number | undefined> = []
  const readCpu = (pid: number | undefined) => { pids.push(pid); return text == null ? null : parseProcStat(text) }
  const { hls, start } = await setup(t, { readCpu, cores: 4 })
  const { s, proc } = start()
  proc.stdout.write('frame=240\nfps=47.92\nout_time_us=10000000\nspeed=2.0x\nprogress=continue\n')
  const started = Date.now()
  // 4 CPU seconds over 2 s of wall time on 4 cores: half the machine
  text = procStat(300, 100)
  let stats = hls.stats(s, started + 2000)
  assert.equal(stats.fps, 47.92)
  assert.equal(stats.cpu, 0.5)
  assert.deepEqual(pids, [4242])
  // The next poll measures only its own window: 1 CPU second in 2 s on 4 cores
  text = procStat(350, 150)
  assert.equal(hls.stats(s, started + 4000).cpu, 0.125)
  // A poll right after another repeats the last value instead of dividing by a tiny window
  text = procStat(400, 150)
  assert.equal(hls.stats(s, started + 4100).cpu, 0.125)
  // Without /proc (macOS) there is no reading
  text = null
  stats = hls.stats(s, started + 6000)
  assert.equal(stats.cpu, null)
  // A finished ffmpeg uses no CPU and has no pid to read
  t.mock.method(console, 'log', () => {})
  proc.emit('exit', 0, null)
  assert.equal(hls.stats(s, started + 8000).cpu, null)
})

test('cpu is null where /proc does not exist', async t => {
  const { hls, start } = await setup(t, { readCpu: () => null })
  const { s } = start()
  assert.equal(hls.stats(s).cpu, null)
  assert.equal(hls.stats(s).fps, null)
})
