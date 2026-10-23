import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHlsSessions, DEFAULT_HLS_LIVE, HlsFailedError, HlsNotFoundError, parseProcStat } from './hls.ts'
import type { FfmpegProcess, HlsLive, HlsSessions, HlsSessionsOptions, StartOptions } from './hls.ts'
import { PlaybackBusyError } from './errors.ts'
import { TIMELINE_OFFSET } from './media.ts'
import { fragment, initSegment } from './test-helpers.ts'

const info = { duration: 60, startTime: 0, video: { codec: 'h264' }, audio: [], subtitles: [{ index: 0, codec: 'subrip', language: null, title: null, text: true }] }
/** A keyframe every 2 s: the plan cuts segments at 0, 6, 12 … 54. */
const keyframes = Array.from({ length: 30 }, (_, i) => i * 2)

class FakeProcess extends EventEmitter {
  pid = 4242
  stdout = new PassThrough()
  stderr = new PassThrough()
  media = new PassThrough()
  stdio = [null, this.stdout, this.stderr, this.media]
  signals: string[] = []
  readonly args: string[]
  constructor (args: string[]) { super(); this.args = args }
  kill (signal?: NodeJS.Signals | number): boolean { this.signals.push(String(signal)); return true }
  /** Writes the init segment once, then a fragment for each time (on the file's timeline). */
  send (...times: number[]): void {
    if (!this.sentInit) { this.media.write(initSegment()); this.sentInit = true }
    for (const t of times) this.media.write(fragment(t + TIMELINE_OFFSET, 100))
  }

  sentInit = false
  /** ffmpeg reached the end of the file: its output is read before the process closes. */
  async finish (): Promise<void> { this.media.end(); await tick(); this.emit('close', 0, null) }
  /** Where this run seeks, from its -ss argument (0 without one). */
  get seek (): number { const i = this.args.indexOf('-ss'); return i < 0 ? 0 : Number(this.args[i + 1]) }
}

const tick = (): Promise<void> => new Promise(resolve => setImmediate(resolve))

interface Setup {
  hls: HlsSessions
  dir: string
  live: HlsLive
  procs: FakeProcess[]
  start: (options?: Partial<StartOptions>) => { s: ReturnType<HlsSessions['start']>, proc: FakeProcess }
  /** The newest process. */
  last: () => FakeProcess
}

async function setup (t: { after: (fn: () => Promise<void>) => void }, options: Partial<HlsSessionsOptions> = {}): Promise<Setup> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'magplay-hls-'))
  const dir = path.join(root, 'hls')
  const live = { ...DEFAULT_HLS_LIVE, maxSessions: 2 }
  const procs: FakeProcess[] = []
  const hls = createHlsSessions({
    dir,
    live: () => live,
    spawnProcess: (_command, args) => { const p = new FakeProcess(args); procs.push(p); return p as unknown as FfmpegProcess },
    ...options,
  })
  t.after(async () => {
    await hls.close()
    await fs.rm(root, { recursive: true, force: true })
  })
  const start = (overrides: Partial<StartOptions> = {}) => {
    const s = hls.start({ input: 'http://127.0.0.1/raw/x/0', info, audio: 0, start: 0, mode: 'remux', keyframes, ...overrides })
    return { s, proc: procs.at(-1)! }
  }
  return { hls, dir, live, procs, start, last: () => procs.at(-1)! }
}

/** Bytes of one fragment from FakeProcess.send(). */
const F = fragment(0, 100).length
const read = async (files: string[]): Promise<number> => (await Promise.all(files.map(f => fs.readFile(f)))).reduce((sum, b) => sum + b.length, 0)

test('the HLS folder is emptied at creation and close() stops every session and deletes its output', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'magplay-hls-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  await fs.mkdir(path.join(root, 'hls', 'stale'), { recursive: true })
  let proc: FakeProcess | undefined
  const hls = createHlsSessions({ dir: path.join(root, 'hls'), spawnProcess: (_c, args) => (proc = new FakeProcess(args)) as unknown as FfmpegProcess })
  assert.deepEqual(await fs.readdir(path.join(root, 'hls')), [])
  const s = hls.start({ input: 'x', info: { ...info, duration: 600 }, audio: 0, start: 0, mode: 'remux', keyframes: Array.from({ length: 300 }, (_, i) => i * 2) })
  proc!.send(0, 300) // far ahead of the player: paused
  await tick()
  await hls.close()
  assert.deepEqual(proc!.signals, ['SIGSTOP', 'SIGCONT', 'SIGKILL'])
  assert.equal(hls.get(s.id), undefined)
  assert.deepEqual(await fs.readdir(path.join(root, 'hls')), [])
})

test('the playlist lists every planned segment up front, on the file timeline', async t => {
  const { hls, start } = await setup(t)
  const { s } = start()
  const playlist = await hls.playlist(s.id)
  assert.match(playlist, /#EXT-X-PLAYLIST-TYPE:VOD/)
  assert.equal(playlist.match(/^seg_\d+\.m4s$/gm)?.length, 10)
  assert.match(playlist, /#EXT-X-ENDLIST/)
  await assert.rejects(hls.playlist('nope'), HlsNotFoundError)
})

test('fragments are published as whole segments once ffmpeg has passed the next boundary', async t => {
  const { hls, start } = await setup(t)
  const { s, proc } = start()
  const init = hls.init(s.id)
  const first = hls.segment(s.id, 0)
  proc.send(0, 2, 4)
  await tick()
  assert.equal(hls.stats(s).ready.length, 0) // segment 0 could still grow
  proc.send(6)
  await tick()
  assert.equal(await read(await first), 3 * F)
  assert.ok((await fs.stat(await init)).size > 0)
  hls.touch(s.id, 1)
  assert.deepEqual(hls.stats(s).ready, [[0, 6]])
  assert.equal(hls.stats(s).readyUntil, 6)
  assert.equal(hls.stats(s).produced, 6)
})

test('a segment far ahead restarts ffmpeg one keyframe early and drops that warm-up; a near one waits', async t => {
  const { hls, start, procs, last } = await setup(t)
  const { s, proc } = start()
  proc.send(0, 2, 4, 6)
  await tick()
  // Segment 1 (6–12) is right behind the running ffmpeg: no restart
  const near = hls.segment(s.id, 1)
  near.catch(() => {}) // hls.js aborts this request when it seeks; here it is left waiting until close
  assert.equal(procs.length, 1)
  // Segment 7 starts at 42, well past it: restart, seeking to the keyframe at 40 (+ margin)
  const far = hls.segment(s.id, 7)
  assert.equal(procs.length, 2)
  assert.deepEqual(proc.signals, ['SIGKILL'])
  assert.ok(Math.abs(last().seek - 40.15) < 1e-9, String(last().seek))
  last().send(40, 42, 44, 46, 48)
  await tick()
  assert.equal(await read(await far), 3 * F) // 42, 44, 46; the warm-up fragment at 40 isn't part of any segment
  assert.deepEqual(hls.stats(s).ready, [[0, 6], [42, 48]])
  // The warm-up's own segment (36–42) wasn't covered from its start, so it isn't published
  const files = await fs.readdir(path.join(s.dir, 'run1'))
  assert.equal(files.filter(f => f.endsWith('.m4s')).length, 4) // 42, 44, 46 published and 48 still being written
})

test('a segment already published is served without ffmpeg, and seeking back to it never restarts', async t => {
  const { hls, start, procs } = await setup(t)
  const { s, proc } = start()
  proc.send(0, 2, 4, 6, 8, 10, 12)
  await tick()
  assert.equal((await hls.segment(s.id, 0)).length, 3)
  assert.equal((await hls.segment(s.id, 1)).length, 3)
  assert.equal(procs.length, 1)
  await assert.rejects(hls.segment(s.id, 10), HlsNotFoundError)
})

test('a keyframe the index got wrong is covered by the fragment that spans it', async t => {
  const { hls, start } = await setup(t)
  const { s, proc } = start()
  proc.send(0, 2, 4, 5, 13) // no fragment starts between 6 and 12: the one from 5 runs past 6
  await tick()
  const zero = await hls.segment(s.id, 0)
  assert.equal(zero.length, 4)
  assert.deepEqual(await hls.segment(s.id, 1), [zero[3]])
})

test('a run that reaches the end of the file publishes the last segment, and later requests restart ffmpeg', async t => {
  const { hls, start, procs, last } = await setup(t)
  const { s } = start({ start: 50 })
  assert.equal(hls.stats(s).ready.length, 0)
  assert.ok(Math.abs(last().seek - 46.15) < 1e-9) // segment 8 (48–54), keyframe before it at 46
  last().send(46, 48, 50, 52, 54, 56, 58)
  await last().finish()
  assert.deepEqual(hls.stats(s).ready, [[48, 60]])
  assert.equal(hls.stats(s).running, false)
  const earlier = hls.segment(s.id, 2)
  assert.equal(procs.length, 2)
  last().send(10, 12, 14, 16, 18)
  await tick()
  assert.equal((await earlier).length, 3)
})

test('waiting requests fail when ffmpeg fails, and cancelling one stops only that wait', async t => {
  const { hls, start } = await setup(t)
  const { s, proc } = start()
  const controller = new AbortController()
  const cancelled = hls.segment(s.id, 0, controller.signal)
  const failing = hls.segment(s.id, 0)
  controller.abort()
  await assert.rejects(cancelled)
  t.mock.method(console, 'error', () => {})
  proc.stderr.write('Invalid data found when processing input\n')
  await tick()
  proc.emit('close', 1, null)
  await assert.rejects(failing, /Invalid data/)
  assert.equal(hls.stats(s).failed, true)
  await assert.rejects(hls.segment(s.id, 0), HlsFailedError)
})

test('ffmpeg startup errors are reported instead of crashing the service', async t => {
  const { hls, start } = await setup(t)
  const { s, proc } = start()
  proc.emit('error', new Error('spawn ffmpeg ENOENT'))
  assert.equal(hls.stats(s).failed, true)
  assert.equal(hls.stats(s).running, false)
  assert.match(hls.stats(s).error ?? '', /Could not start ffmpeg.*ENOENT/)
})

test('ffmpeg pauses far ahead of the player and of the last segment asked for, and resumes when either catches up', async t => {
  const stopped: string[] = []
  const { hls, start } = await setup(t, { onStop: id => stopped.push(id) })
  const { s, proc } = start({ info: { ...info, duration: 600 }, keyframes: Array.from({ length: 300 }, (_, i) => i * 2) })
  proc.send(0, 300)
  await tick()
  assert.equal(s.paused, true)
  hls.touch(s.id, -50)
  assert.equal(s.position, 0)
  hls.touch(s.id, 200)
  assert.equal(s.paused, false)
  hls.touch(s.id, 0)
  assert.equal(s.paused, true)
  hls.segment(s.id, 50).catch(() => {}) // 300–306: hls.js is buffering there, so ffmpeg must keep going
  assert.equal(s.paused, false)
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
  const replacement = start({ replaces: first.s.id })
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
  assert.throws(() => start({ replaces: first.s.id }), PlaybackBusyError)
  assert.deepEqual(first.proc.signals, [])
  assert.equal(hls.get(first.s.id), first.s)
})

test('the disk budget evicts segments far from the player first, then stops the producer with a useful failure', async t => {
  const { hls, live, start } = await setup(t)
  const { s, proc } = start({ info: { ...info, duration: 600 }, keyframes: Array.from({ length: 300 }, (_, i) => i * 2) })
  proc.send(...Array.from({ length: 70 }, (_, i) => i * 2)) // 0–138: segments 0–22 published
  await tick()
  hls.touch(s.id, 130)
  const total = hls.summary().bytes
  live.hlsMaxBytes = total - 3 * 116 // one segment too many
  await hls.checkResources()
  assert.deepEqual(hls.stats(s).ready, [[6, 138]]) // the segment furthest from 130 went
  assert.deepEqual(proc.signals, [])
  live.hlsMaxBytes = 100
  await hls.checkResources()
  assert.deepEqual(proc.signals, ['SIGKILL'])
  assert.equal(hls.stats(s).failed, true)
  assert.match(hls.stats(s).error ?? '', /HLS disk limit reached/)
  assert.deepEqual(hls.stats(s).ready, [])
  proc.emit('close', null, 'SIGKILL')
  assert.match(hls.stats(s).error ?? '', /HLS disk limit reached/)
  assert.equal(hls.summary().active, 0)
})

test('without a keyframe index the playlist grows from one run and ends with it', async t => {
  const { hls, start, procs } = await setup(t)
  const { s, proc } = start({ keyframes: null, start: 30 })
  assert.equal(proc.seek, 0) // a growing playlist always starts at the beginning
  const playlist = hls.playlist(s.id)
  proc.send(0, 2.5, 5, 7.5, 10, 12.5)
  await tick()
  const first = await playlist
  assert.match(first, /#EXT-X-PLAYLIST-TYPE:EVENT/)
  assert.match(first, /#EXTINF:7\.500000,\nseg_0\.m4s\n$/)
  assert.doesNotMatch(first, /ENDLIST/)
  proc.send(15)
  await proc.finish()
  const done = await hls.playlist(s.id)
  assert.match(done, /seg_0\.m4s\n#EXTINF:7\.500000,\nseg_1\.m4s\n#EXTINF:45\.000000,\nseg_2\.m4s\n#EXT-X-ENDLIST/)
  assert.equal((await hls.segment(s.id, 2)).length, 1)
  assert.equal(procs.length, 1)
  assert.equal(hls.stats(s).growing, true)
})

test('subtitles from every run are merged on the file timeline', async t => {
  const { hls, start, last } = await setup(t)
  const { s, proc } = start()
  await fs.writeFile(path.join(s.dir, 'run0', 'sub_0.vtt'), 'WEBVTT\n\n00:01.000 --> 00:02.000\nFirst\n')
  hls.segment(s.id, 8).catch(() => {})
  assert.notEqual(last(), proc)
  await fs.writeFile(path.join(s.dir, 'run1', 'sub_0.vtt'), 'WEBVTT\n\n00:50.000 --> 00:52.000\nLast\n')
  assert.equal(hls.subtitles(s.id, 0), 'WEBVTT\n\n00:01.000 --> 00:02.000\nFirst\n\n\n00:50.000 --> 00:52.000\nLast\n')
  assert.throws(() => hls.subtitles(s.id, 3), HlsNotFoundError)
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
  await tick()
  // Every poll sets the baseline the next one measures from, so a first poll at a chosen time keeps the windows
  // exact (the sample taken at start uses the real clock)
  const started = Date.now()
  hls.stats(s, started)
  // 4 CPU seconds over 2 s of wall time on 4 cores: half the machine
  text = procStat(300, 100)
  let stats = hls.stats(s, started + 2000)
  assert.equal(stats.fps, 47.92)
  assert.equal(stats.speed, 2)
  assert.equal(stats.cpu, 0.5)
  assert.deepEqual(pids, [4242, 4242])
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
})

test('readiness fires once when the starting segment is published, and replacement signals are intentional outcomes', async t => {
  const { createLogging, createMetrics } = await import('@magplay/observability')
  const logging = createLogging({ level: 'debug', sink: { write () {} } })
  const telemetry = createMetrics({ runtime: false })
  let ready = 0
  const { start, last } = await setup(t, { logger: logging.logger, metrics: telemetry.metrics })
  t.after(() => { telemetry.close(); return Promise.resolve() })
  const { s } = start({ start: 20, onReady: () => ready++ }) // segment 3, 18–24
  last().send(16, 18, 20, 22)
  await tick()
  assert.equal(ready, 0)
  last().send(24, 26, 28, 30)
  await tick()
  assert.equal(ready, 1)
  assert.equal(logging.tail().filter(l => l.event === 'hls.media.published').length, 1)
  const replaced = last()
  start({ replaces: s.id })
  replaced.emit('close', null, 'SIGKILL')
  assert.equal(logging.tail().filter(l => l.level === 'error').length, 0)
  assert.equal(logging.tail().find(l => l.event === 'ffmpeg.exited')?.stopReason, 'replaced')
  assert.match(await telemetry.registry.metrics(), /magplay_jobs_total\{kind="conversion",outcome="cancelled"\} 1/)
})
