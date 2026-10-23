import { noopLogger, noopMetrics } from '@magplay/observability'
import type { Logger, Metrics, OperationContext } from '@magplay/observability'
// HLS sessions: one per player, each a full-length playlist on the file's own timeline whose segments are made on
// demand. One ffmpeg run at a time writes fragmented MP4 from some segment onward; segments it completes are
// published and stay until the disk budget needs the space. A request for a segment the running ffmpeg won't reach
// soon restarts ffmpeg there. Files without a keyframe index get one run from the start and a growing playlist.
// Created by createHlsSessions(); close() stops all.
import { spawn } from 'node:child_process'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { SessionStats } from '@magplay/api-contract'
import { PlaybackBusyError } from './errors.ts'
import { ffmpegArgs, resolveTranscodeEncoder, TIMELINE_OFFSET } from './media.ts'
import type { FfmpegArgsOptions } from './media.ts'
import { fragmentSplitter, fragmentStart, readInit } from './mp4.ts'
import { nodeRemuxProcess } from './node-remux.ts'
import type { InitInfo } from './mp4.ts'
import { fixedPlan, keyframePlan, renderPlaylist, runStart, SEGMENT_SECONDS, segmentAt, TIME_TOLERANCE } from './plan.ts'
import type { SegmentPlan } from './plan.ts'

// Pause ffmpeg when it's this far ahead of the player, so the disk isn't filled with segments nobody watches yet
const AHEAD_PAUSE_S = 240
const AHEAD_RESUME_S = 120
/** A requested segment this close ahead of the running ffmpeg is waited for; further away, ffmpeg restarts there. */
const WAIT_AHEAD_S = { remux: 30, transcode: SEGMENT_SECONDS + 1 } as const
/** When disk space must be reclaimed, segments this close to the player are kept: behind it, and ahead of it. */
const KEEP_BEHIND_S = 60
const KEEP_AHEAD_S = 300
/** A start-time difference larger than this isn't priming; the fragment is taken as it is. */
const MAX_SKEW_S = 0.25
// /proc/<pid>/stat counts CPU time in clock ticks; Linux uses 100 per second on every common platform
const CLOCK_TICKS = 100

/** CPU seconds a process has used (user + system), from Linux's /proc/<pid>/stat, or null where there is no /proc (macOS). */
export function readProcCpu (pid: number | undefined): number | null {
  if (!pid) return null
  try {
    return parseProcStat(fs.readFileSync(`/proc/${pid}/stat`, 'utf8'))
  } catch {
    return null
  }
}

/**
 * utime + stime from a /proc/<pid>/stat line, in seconds. The command name is in parentheses and may hold spaces,
 * so fields are counted after the last ")": state is field 3, utime 14 and stime 15.
 */
export function parseProcStat (text: string): number | null {
  const fields = text.slice(text.lastIndexOf(')') + 2).split(' ')
  const ticks = Number(fields[11]) + Number(fields[12])
  return Number.isFinite(ticks) ? ticks / CLOCK_TICKS : null
}

/** The ChildProcess surface sessions use, so tests can pass a stand-in. ffmpeg writes progress to stdout and media to fd 3. */
export type FfmpegProcess = Pick<ChildProcess, 'pid' | 'kill' | 'on'> & {
  stdout: NodeJS.ReadableStream
  stderr: NodeJS.ReadableStream
  stdio: ArrayLike<unknown>
}
export type SpawnProcess = (command: string, args: string[], options: SpawnOptions) => FfmpegProcess

/** Settings read on each start and check, so a saved change applies to the next one. */
export interface HlsLive {
  ffmpegPath: string
  maxSessions: number
  /** Soft budget for all sessions' output. */
  hlsMaxBytes: number
  /** Free space to keep on the HLS disk. */
  minFreeBytes: number
  transcodeMaxHeight: number
  transcodeEncoder?: string
  vaapiDevice?: string
  detectedEncoders?: string[]
}

export const DEFAULT_HLS_LIVE: HlsLive = { ffmpegPath: 'ffmpeg', maxSessions: 2, hlsMaxBytes: 8 * 1024 ** 3, minFreeBytes: 256 * 1024 ** 2, transcodeMaxHeight: 720, transcodeEncoder: 'auto', vaapiDevice: '/dev/dri/renderD128', detectedEncoders: [] }

export interface HlsSessionsOptions {
  logger?: Logger
  metrics?: Metrics
  /** Session folders go here. It is emptied at creation: leftovers from a previous run are never reused. */
  dir: string
  live?: () => HlsLive
  spawnProcess?: SpawnProcess
  /** CPU seconds for a pid, or null when unknown. */
  readCpu?: (pid: number | undefined) => number | null
  cores?: number
  /** A session nobody polled or requested anything from for this long is stopped. */
  idleMs?: number
  /** Called after a session is stopped, by any path. */
  onStop?: (id: string) => void
}

export interface StartOptions extends Pick<FfmpegArgsOptions, 'input' | 'audio'> {
  info: FfmpegArgsOptions['info'] & { duration: number | null }
  /** `node-remux` repackages in this process when the browser can't and ffmpeg isn't installed. The session reports `remux`. */
  mode: 'remux' | 'transcode' | 'node-remux'
  /** Where playback starts on the file's timeline: the first ffmpeg run begins at the segment holding it. */
  start: number
  /** The file's keyframe times, for copied video; null (or an unknown duration) plays a growing playlist from the start. */
  keyframes: readonly number[] | null
  context?: OperationContext
  /** Called once the segment playback starts in is ready. */
  onReady?: () => void
  /** A session this one replaces: it doesn't count against the limit and is stopped once this one is admitted. */
  replaces?: string | undefined
}

export interface HlsSession {
  readonly id: string
  readonly mode: 'remux' | 'transcode'
  readonly dir: string
  /** The player's position on the file's timeline, from status polls. */
  readonly position: number
  /** The running ffmpeg is SIGSTOPped because it's far ahead of the player. */
  readonly paused: boolean
  /** Why the session can't continue (ffmpeg failed, or the disk budget stopped it), kept for status polls. */
  readonly failure: string | null
  /** No keyframe index (or no duration): a playlist that grows from the start instead of covering the whole file. */
  readonly growing: boolean
}

/** A session asked for a file it doesn't have: an unknown session, segment number or subtitle track. */
export class HlsNotFoundError extends Error {
  override name = 'HlsNotFoundError'
}
/** ffmpeg failed, or the session was stopped, while a request waited for its output. */
export class HlsFailedError extends Error {
  override name = 'HlsFailedError'
}

export interface HlsSessions {
  /** Creates a session and starts ffmpeg or a Node remux, or throws PlaybackBusyError when the limit or disk budget doesn't allow another. */
  start: (options: StartOptions) => HlsSession
  get: (id: string) => HlsSession | undefined
  /** Marks a session as alive; `position` is the player's time on the file's timeline. */
  touch: (id: string, position?: number) => HlsSession | null
  stats: (session: HlsSession, now?: number) => SessionStats
  /** The media playlist; a growing one is answered once its first segment is ready. */
  playlist: (id: string, signal?: AbortSignal) => Promise<string>
  /** Path of the init segment, once ffmpeg has written it. */
  init: (id: string, signal?: AbortSignal) => Promise<string>
  /** Files that make up segment `n`, in order, waiting for ffmpeg or restarting it there as needed. */
  segment: (id: string, n: number, signal?: AbortSignal) => Promise<string[]>
  /** Every cue ffmpeg has written for embedded text subtitle `track` so far, as one WebVTT document. */
  subtitles: (id: string, track: number) => string
  stop: (id: string, reason?: 'closed' | 'replaced' | 'idle' | 'shutdown' | 'cleared') => void
  /** Stops every session and deletes its output; returns how many there were. */
  stopAll: () => number
  /** Sessions running and their bytes on disk, for the Debug page. */
  summary: () => { active: number, bytes: number }
  /** Soft disk budget: evicts segments far from the player, then stops sessions. Runs on a timer; exposed for tests. */
  checkResources: () => Promise<void>
  /** Stops the timers and every ffmpeg (paused ones would outlive the server) and deletes the output. */
  close: () => Promise<void>
}

interface Fragment { start: number, file: string }

interface Run {
  n: number
  /** The segment this run was started for. */
  first: number
  /** Where it seeks on the file's timeline. */
  target: number
  dir: string
  proc: FfmpegProcess
  /** Finished fragments not yet assigned to a segment. */
  fragments: Fragment[]
  /** The fragment being written. */
  current: (Fragment & { fd: number }) | null
  /** The last fragment assigned, which may also cover a following segment whose keyframe the index got wrong. */
  previous: Fragment | null
  /** Start of the newest fragment: how far this run has got. */
  latest: number | null
  /** Start of its first fragment: where its output begins. */
  firstStart: number | null
  /** The next segment to decide on. */
  next: number
  outTime: number
  speed: number | null
  fps: number | null
  cpuSample: { at: number, seconds: number }
  cpu: number | null
  paused: boolean
  exitCode: number | string | null
  stderr: string[]
  stopReason: string | null
  started: number
  log: Logger
}

interface Published { files: string[], bytes: number }

interface Waiter { key: number | 'init', resolve: () => void, reject: (err: Error) => void }

interface Session {
  id: string
  mode: 'remux' | 'transcode'
  /** ffmpeg, or Mediabunny in this process (Node remux) when ffmpeg isn't installed. */
  producer: 'ffmpeg' | 'node'
  /** The video encoder: `copy` for a remux, the resolved H.264 encoder for a transcode, `node` for a Node remux. */
  encoder: string
  dir: string
  input: string
  info: StartOptions['info']
  audio: number
  /** Null for a growing playlist. */
  plan: SegmentPlan | null
  /** Segment starts: the plan's, or for a growing playlist, the ones closed so far plus the open one. */
  starts: number[]
  /** Growing playlist: conversion has reached the end of the file. */
  ended: boolean
  /** Growing playlist: where the last segment ends once ended. */
  end: number
  initFile: string | null
  initInfo: InitInfo | null
  segments: Map<number, Published>
  /** Published segments referring to each fragment file. */
  refs: Map<string, number>
  sizes: Map<string, number>
  run: Run | null
  runs: number
  position: number
  /** Start of the last segment the player asked for; ffmpeg isn't paused short of it. */
  demand: number
  lastSeen: number
  failure: string | null
  waiters: Set<Waiter>
  /** The segment playback started in; readiness is reported once it is published. */
  startSegment: number
  /**
   * How far every fragment sits from the indexed keyframe it starts on, the same for every run: ffmpeg's -ss counts
   * from its own start time, which includes the audio codec's priming delay that the probe doesn't. Learned from
   * the first fragment; 0 without an index.
   */
  skew: number | null
  ready: boolean
  onReady: (() => void) | undefined
  stopped: boolean
  log: Logger
  started: number
  /** The running ffmpeg is paused ahead of the player. */
  readonly paused: boolean
  readonly growing: boolean
}

const spawnFfmpeg: SpawnProcess = (command, args, options) => spawn(command, args, options) as FfmpegProcess

export function createHlsSessions ({
  dir,
  live = () => DEFAULT_HLS_LIVE,
  spawnProcess = spawnFfmpeg,
  readCpu = readProcCpu,
  cores = os.availableParallelism(),
  idleMs = 45_000,
  onStop = () => {},
  logger = noopLogger,
  metrics = noopMetrics,
}: HlsSessionsOptions): HlsSessions {
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })

  const sessions = new Map<string, Session>()
  const removals = new Set<Promise<void>>()
  const warnedEncoderFallbacks = new Set<string>()

  function removeDir (folder: string): void {
    const removal: Promise<void> = fs.promises.rm(folder, { recursive: true, force: true })
      .catch((err: unknown) => logger.error('hls.cleanup.failed', { err }))
      .then(() => { removals.delete(removal) })
    removals.add(removal)
  }

  const bytesOf = (s: Session): number => [...s.sizes.values()].reduce((sum, n) => sum + n, 0)

  function unlink (s: Session, file: string): void {
    if ((s.refs.get(file) ?? 0) > 0) return
    s.sizes.delete(file)
    // Synchronous like the writes, so the folder never holds more than the byte count says
    try { fs.rmSync(file, { force: true }) } catch {}
  }

  // ---- Waiting for output ----

  function settle (s: Session, key: number | 'init'): void {
    for (const w of s.waiters) if (w.key === key) { s.waiters.delete(w); w.resolve() }
  }

  function failWaiters (s: Session, err: Error): void {
    for (const w of s.waiters) w.reject(err)
    s.waiters.clear()
  }

  function wait (s: Session, key: number | 'init', signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const abort = (): void => { s.waiters.delete(w); reject(signal?.reason instanceof Error ? signal.reason : new HlsFailedError('Request cancelled')) }
      const w: Waiter = {
        key,
        resolve: () => { signal?.removeEventListener('abort', abort); resolve() },
        reject: err => { signal?.removeEventListener('abort', abort); reject(err) },
      }
      if (signal?.aborted) return abort()
      signal?.addEventListener('abort', abort, { once: true })
      s.waiters.add(w)
    })
  }

  // ---- Publishing segments ----

  function publish (s: Session, k: number, files: string[]): void {
    if (s.segments.has(k)) return
    for (const f of files) s.refs.set(f, (s.refs.get(f) ?? 0) + 1)
    s.segments.set(k, { files, bytes: files.reduce((sum, f) => sum + (s.sizes.get(f) ?? 0), 0) })
    settle(s, k)
    if (!s.ready && k === s.startSegment) {
      s.ready = true
      s.log.info('hls.media.published', { durationMs: performance.now() - s.started, segment: k })
      s.onReady?.()
      s.onReady = undefined
    }
  }

  function evict (s: Session, k: number): void {
    const seg = s.segments.get(k)
    if (!seg) return
    s.segments.delete(k)
    for (const f of seg.files) {
      const left = (s.refs.get(f) ?? 1) - 1
      if (left > 0) s.refs.set(f, left)
      else { s.refs.delete(f); unlink(s, f) }
    }
  }

  /**
   * Assigns a run's finished fragments to planned segments, up to `upTo` (the start of the fragment just begun, or
   * Infinity once ffmpeg finished the file). A segment is published only when the run covered it from its start:
   * the warm-up before a restart's first boundary, and anything already published, are dropped.
   */
  function assign (s: Session, run: Run, upTo: number): void {
    const starts = s.starts
    while (run.next < starts.length) {
      const k = run.next
      const start = starts[k] ?? 0
      const end = starts[k + 1] ?? Infinity
      if (upTo !== Infinity && upTo < end - TIME_TOLERANCE) return
      const files = run.fragments.filter(f => f.start < end - TIME_TOLERANCE)
      run.fragments = run.fragments.slice(files.length)
      const covered = run.firstStart !== null && (k === 0 ? run.target <= (s.plan?.origin ?? 0) + TIME_TOLERANCE : run.firstStart <= start + TIME_TOLERANCE)
      const own = files.filter(f => f.start >= start - TIME_TOLERANCE)
      let parts = own
      if (covered && !own.length && run.previous) {
        // The index named a keyframe that isn't one: the fragment before covers this segment's start
        parts = [run.previous]
        s.log.warn('hls.plan.mismatch', { segment: k, start })
      }
      if (covered && parts.length && !s.segments.has(k)) publish(s, k, parts.map(f => f.file))
      const last = files.at(-1)
      for (const f of files) if (f !== last) unlink(s, f.file)
      if (last) {
        if (run.previous && run.previous !== last) unlink(s, run.previous.file)
        run.previous = last
      }
      run.next++
    }
  }

  /** The first fragment's distance from the nearest indexed keyframe, when that is small enough to be this skew. */
  function skew (s: Session, at: number): number {
    let nearest = Infinity
    for (const t of s.plan?.keyframes ?? []) if (Math.abs(t - at) < Math.abs(nearest - at)) nearest = t
    const d = at - nearest
    if (Math.abs(d) > MAX_SKEW_S) return 0
    if (Math.abs(d) > TIME_TOLERANCE) s.log.debug('hls.skew', { seconds: d })
    return d
  }

  // ---- Runs ----

  function throttle (s: Session): void {
    const run = s.run
    if (!run || run.exitCode !== null || run.latest === null) return
    const ahead = run.latest - Math.max(s.position, s.demand)
    if (!run.paused && ahead > AHEAD_PAUSE_S) { run.proc.kill('SIGSTOP'); run.paused = true }
    if (run.paused && ahead < AHEAD_RESUME_S) { run.proc.kill('SIGCONT'); run.paused = false }
  }

  function kill (run: Run): void {
    if (run.exitCode !== null) return
    if (run.paused) run.proc.kill('SIGCONT')
    run.paused = false
    run.proc.kill('SIGKILL')
  }

  /** Stops a run and deletes whatever it wrote that no segment uses. */
  function endRun (s: Session, run: Run, reason: string): void {
    run.stopReason ??= reason
    kill(run)
    closeCurrent(s, run, false)
    for (const f of run.fragments) unlink(s, f.file)
    run.fragments = []
    if (run.previous) unlink(s, run.previous.file)
    run.previous = null
    if (s.run === run) s.run = null
  }

  /** Closes the fragment being written; `keep` adds it to the run's finished fragments. */
  function closeCurrent (s: Session, run: Run, keep: boolean): void {
    const current = run.current
    if (!current) return
    run.current = null
    try { fs.closeSync(current.fd) } catch {}
    if (keep) run.fragments.push({ start: current.start, file: current.file })
    else unlink(s, current.file)
  }

  function write (s: Session, run: Run, data: Buffer): void {
    const current = run.current
    if (!current) return
    fs.writeSync(current.fd, data)
    s.sizes.set(current.file, (s.sizes.get(current.file) ?? 0) + data.length)
  }

  function startRun (s: Session, k: number): void {
    const { ffmpegPath, transcodeMaxHeight, vaapiDevice } = live()
    const target = s.plan ? runStart(s.plan, k) : 0
    const n = s.runs++
    const runDir = path.join(s.dir, `run${n}`)
    fs.mkdirSync(runDir, { recursive: true })
    let proc: FfmpegProcess
    if (s.producer === 'node') {
      // Mediabunny starts on the keyframe at or before the target and rebases its output there
      const firstKeyframe = s.plan ? s.plan.keyframes.filter(t => t <= target + TIME_TOLERANCE).at(-1) ?? s.plan.keyframes[0] ?? null : null
      proc = nodeRemuxProcess({ input: s.input, audio: s.audio, start: target, firstKeyframe })
    } else {
      const args = ffmpegArgs({ input: s.input, info: s.info, audio: s.audio, start: target, mode: s.mode, dir: runDir, transcodeMaxHeight, transcodeEncoder: s.encoder, ...(vaapiDevice ? { vaapiDevice } : {}) })
      proc = spawnProcess(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe', 'pipe'] })
    }
    const run: Run = {
      n,
      first: k,
      target,
      dir: runDir,
      proc,
      fragments: [],
      current: null,
      previous: null,
      latest: null,
      firstStart: null,
      next: s.plan ? Math.max(0, k - 1) : 0,
      outTime: 0,
      speed: null,
      fps: null,
      cpuSample: { at: Date.now(), seconds: 0 },
      cpu: null,
      paused: false,
      exitCode: null,
      stderr: [],
      stopReason: null,
      started: performance.now(),
      log: s.log.child({ run: n }),
    }
    s.run = run
    s.failure = null
    run.log.info('hls.run.started', { segment: k, startSeconds: target, producer: s.producer })
    let fragments = 0

    const split = fragmentSplitter({
      init (data) {
        if (s.initFile) return
        const file = path.join(s.dir, 'init.mp4')
        fs.writeFileSync(file, data)
        s.initFile = file
        s.initInfo = readInit(data)
        settle(s, 'init')
      },
      begin (moof) {
        if (s.stopped || s.run !== run) return
        closeCurrent(s, run, true)
        const shown = s.initInfo ? fragmentStart(moof, s.initInfo) : null
        if (shown !== null && s.skew === null) s.skew = skew(s, shown - TIMELINE_OFFSET)
        const start = shown === null ? (run.latest ?? target) : shown - TIMELINE_OFFSET - (s.skew ?? 0)
        if (s.plan) assign(s, run, start)
        else grow(s, run, start)
        const file = path.join(run.dir, `f${fragments++}.m4s`)
        run.current = { start, file, fd: fs.openSync(file, 'w') }
        run.firstStart ??= start
        run.latest = start
        write(s, run, moof)
        throttle(s)
      },
      data (chunk) { if (s.run === run) write(s, run, chunk) },
    })
    const media = proc.stdio[3] as NodeJS.ReadableStream | null | undefined
    media?.on('data', (chunk: Buffer) => {
      try { split.push(chunk) } catch (err) {
        run.log.error('hls.media.invalid', { err })
        s.failure = 'The converted stream could not be read.'
        kill(run)
      }
    })
    media?.on('error', () => {}) // the process exit reports what happened

    let buf = ''
    proc.stdout.on('data', (chunk: Buffer | string) => {
      buf = (buf + String(chunk)).slice(-16384)
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        const [key, value = ''] = line.split('=')
        if ((key === 'out_time_us' || key === 'out_time_ms') && Number(value) >= 0) run.outTime = Number(value) / 1e6
        if (key === 'speed' && parseFloat(value)) run.speed = parseFloat(value)
        if (key === 'fps' && Number.isFinite(parseFloat(value))) run.fps = parseFloat(value)
      }
    })
    proc.stderr.on('data', (chunk: Buffer | string) => {
      run.stderr.push(...String(chunk).slice(-8192).trim().split('\n').slice(-20).map(line => line.slice(0, 1024)))
      run.stderr.splice(0, run.stderr.length - 20)
    })
    proc.on('error', (err: Error) => {
      run.exitCode = 'spawn-error'
      run.stderr.push(`Could not start ffmpeg: ${err.message}`)
      metrics.job('conversion', 'failure', (performance.now() - run.started) / 1000)
      run.log.error('ffmpeg.spawn.failed', { err })
      if (s.run === run) fail(s, run)
    })
    proc.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      if (run.exitCode === 'spawn-error') return
      run.exitCode = code ?? signal
      const durationMs = performance.now() - run.started
      const finished = code === 0 && !run.stopReason && split.end()
      metrics.job('conversion', run.stopReason ? run.stopReason === 'resource-limit' ? 'rejected' : 'cancelled' : finished ? 'success' : 'failure', durationMs / 1000)
      run.log[!run.stopReason && !finished ? 'error' : 'info']('ffmpeg.exited', { code: code ?? signal, stopReason: run.stopReason, speed: run.speed, fps: run.fps, outputSeconds: run.outTime, durationMs, ...(!run.stopReason && !finished ? { stderr: run.stderr.slice(-3).join('\n') } : {}) })
      if (s.run !== run || s.stopped) return
      if (finished) {
        closeCurrent(s, run, true)
        if (s.plan) assign(s, run, Infinity)
        else finishGrowing(s, run)
        // The finished run stays as the session's last one, so status keeps its speed and fps
        // A request may still wait for a segment this run didn't publish (it started past it)
        for (const w of [...s.waiters]) if (typeof w.key === 'number' && !s.segments.has(w.key)) ensureProducing(s, w.key)
      } else {
        fail(s, run)
      }
    })
  }

  function fail (s: Session, run: Run): void {
    s.failure ??= run.stderr.slice(-3).join('\n') || 'ffmpeg stopped unexpectedly'
    endRun(s, run, 'failed')
    failWaiters(s, new HlsFailedError(`ffmpeg failed: ${run.stderr.at(-1) ?? 'unknown error'}`))
  }

  // ---- Growing playlists (no keyframe index) ----

  /** Closes the open segment once it holds SEGMENT_SECONDS and a new fragment begins. */
  function grow (s: Session, run: Run, start: number): void {
    const open = s.starts.length - 1
    if (start - (s.starts[open] ?? 0) < SEGMENT_SECONDS - TIME_TOLERANCE || !run.fragments.length) return
    publishFragments(s, open, run)
    s.starts.push(start)
  }

  function finishGrowing (s: Session, run: Run): void {
    if (run.fragments.length) publishFragments(s, s.starts.length - 1, run)
    s.ended = true
    s.end = s.info.duration ?? (run.target + run.outTime)
  }

  function publishFragments (s: Session, k: number, run: Run): void {
    publish(s, k, run.fragments.map(f => f.file))
    run.fragments = []
  }

  // ---- Requests ----

  /** Makes sure segment `k` is coming: the running ffmpeg will reach it soon, or ffmpeg restarts there. */
  function ensureProducing (s: Session, k: number): void {
    const run = s.run
    if (!s.plan) {
      if (run?.paused) { run.proc.kill('SIGCONT'); run.paused = false }
      return
    }
    const start = s.starts[k] ?? 0
    const reach = run ? run.latest ?? run.target : 0
    if (run && run.exitCode === null && k >= run.next && start - reach <= WAIT_AHEAD_S[s.mode]) {
      if (run.paused) { run.proc.kill('SIGCONT'); run.paused = false }
      return
    }
    if (run) endRun(s, run, 'replaced')
    startRun(s, k)
  }

  function sessionOr404 (id: string): Session {
    const s = sessions.get(id)
    if (!s) throw new HlsNotFoundError('No such session')
    s.lastSeen = Date.now()
    return s
  }

  // ---- Lifecycle ----

  function stop (id: string, reason: 'closed' | 'replaced' | 'idle' | 'shutdown' | 'cleared' = 'closed'): void {
    const s = sessions.get(id)
    if (!s) return
    sessions.delete(id)
    s.stopped = true
    s.log.info('hls.stopped', { stopReason: reason, durationMs: performance.now() - s.started, bytes: bytesOf(s), segments: s.segments.size, runs: s.runs })
    if (s.run) endRun(s, s.run, reason)
    failWaiters(s, new HlsFailedError('The playback session was closed'))
    removeDir(s.dir)
    onStop(id)
  }

  function touch (id: string, position?: number): Session | null {
    const s = sessions.get(id)
    if (!s) return null
    s.lastSeen = Date.now()
    if (position !== undefined && Number.isFinite(position) && position >= 0) s.position = position
    throttle(s)
    return s
  }

  /** ffmpeg's share of all CPU cores since the previous call (0–1), or null when unknown; the window is the poll interval. */
  function sampleCpu (run: Run, now: number): number | null {
    if (run.exitCode !== null) return null
    const seconds = readCpu(run.proc.pid)
    if (seconds == null) return null
    const prev = run.cpuSample
    run.cpuSample = { at: now, seconds }
    if (now - prev.at < 500) return run.cpu // closer polls say more about timer jitter than load
    run.cpu = Math.max(0, Math.min(1, (seconds - prev.seconds) / ((now - prev.at) / 1000) / cores))
    return run.cpu
  }

  const segmentEnd = (s: Session, k: number): number => s.starts[k + 1] ?? (s.plan ? s.plan.duration : s.ended ? s.end : (s.starts[k] ?? 0))

  /** Published time ranges, merged. */
  function readyRanges (s: Session): Array<[number, number]> {
    const ranges: Array<[number, number]> = []
    for (const k of [...s.segments.keys()].sort((a, b) => a - b)) {
      const from = s.starts[k] ?? 0
      const to = segmentEnd(s, k)
      const last = ranges.at(-1)
      if (last && from <= last[1] + TIME_TOLERANCE) last[1] = Math.max(last[1], to)
      else ranges.push([from, to])
    }
    return ranges
  }

  let resourceCheck: Promise<void> | null = null
  function checkResources (): Promise<void> {
    resourceCheck ??= (async () => {
      const all = [...sessions.values()].filter(s => !s.failure)
      if (!all.length) return
      const disk = await fs.promises.statfs(dir)
      const { hlsMaxBytes, minFreeBytes } = live()
      let reclaim = Math.max(all.reduce((sum, s) => sum + bytesOf(s), 0) - hlsMaxBytes, minFreeBytes - disk.bavail * disk.bsize)
      if (reclaim <= 0) return
      // First, published segments far from each player, furthest first
      const far = all.flatMap(s => [...s.segments.keys()]
        .filter(k => (s.starts[k] ?? 0) < s.position - KEEP_BEHIND_S || (s.starts[k] ?? 0) > s.position + KEEP_AHEAD_S)
        .map(k => ({ s, k, distance: Math.abs((s.starts[k] ?? 0) - s.position) })))
      for (const { s, k } of far.sort((a, b) => b.distance - a.distance)) {
        if (reclaim <= 0) break
        if (!s.plan) continue // a growing playlist can't make a segment again
        const bytes = s.segments.get(k)?.bytes ?? 0
        evict(s, k)
        reclaim -= bytes
      }
      if (reclaim <= 0) return
      // Then stop producers, largest first; keep the session record so status polls report why
      for (const s of all.sort((a, b) => bytesOf(b) - bytesOf(a))) {
        if (reclaim <= 0) break
        if (!sessions.has(s.id)) continue
        const bytes = bytesOf(s)
        s.log.warn('hls.resource.stopped', { reason: 'storage', bytes })
        if (s.run) endRun(s, s.run, 'resource-limit')
        s.failure = 'HLS disk limit reached. Free space or use an external player, then retry.'
        for (const k of [...s.segments.keys()]) evict(s, k)
        failWaiters(s, new HlsFailedError(s.failure))
        reclaim -= bytes
      }
    })().finally(() => { resourceCheck = null })
    return resourceCheck
  }

  const reaper = setInterval(() => {
    for (const s of sessions.values()) if (Date.now() - s.lastSeen > idleMs) stop(s.id, 'idle')
  }, 10_000)
  reaper.unref()
  const checker = setInterval(() => {
    checkResources().catch((err: unknown) => logger.error('hls.resource.check.failed', { err }))
  }, 2000)
  checker.unref()

  function stopAll (reason: 'cleared' | 'shutdown' = 'cleared'): number {
    const count = sessions.size
    for (const id of [...sessions.keys()]) stop(id, reason)
    return count
  }

  return {
    start ({ input, info, audio, start: at, mode: requested, keyframes, replaces, context, onReady }) {
      const { maxSessions, minFreeBytes, hlsMaxBytes, transcodeEncoder, detectedEncoders } = live()
      const mode = requested === 'transcode' ? 'transcode' : 'remux'
      const producer = requested === 'node-remux' ? 'node' : 'ffmpeg'
      const resolvedEncoder = resolveTranscodeEncoder(transcodeEncoder, detectedEncoders ?? [])
      const requestedEncoder = (transcodeEncoder ?? 'auto').trim()
      if (mode === 'transcode' && requestedEncoder !== 'auto' && requestedEncoder !== 'libx264' && resolvedEncoder === 'libx264' && !warnedEncoderFallbacks.has(requestedEncoder)) {
        warnedEncoderFallbacks.add(requestedEncoder)
        logger.warn('hls.encoder.fallback', { requestedEncoder, encoder: resolvedEncoder })
      }
      const admitted = [...sessions.values()].filter(s => !s.failure && s.id !== replaces)
      if (admitted.length >= maxSessions) {
        metrics.reject('hls', 'capacity')
        logger.warn('resource.rejected', { resource: 'hls', reason: 'capacity', used: admitted.length, limit: maxSessions })
        throw new PlaybackBusyError('Too many HLS players. Close another player or use an external player.')
      }
      const disk = fs.statfsSync(dir)
      if (disk.bavail * disk.bsize < minFreeBytes) {
        metrics.reject('disk', 'free-space')
        logger.warn('resource.rejected', { resource: 'disk', reason: 'free-space', freeBytes: disk.bavail * disk.bsize, limit: minFreeBytes })
        throw new PlaybackBusyError('Not enough free disk space for HLS playback. Free space or use an external player.')
      }
      const used = [...sessions.values()].reduce((sum, s) => sum + bytesOf(s), 0)
      if (used >= hlsMaxBytes) {
        metrics.reject('disk', 'storage')
        logger.warn('resource.rejected', { resource: 'disk', reason: 'storage', used, limit: hlsMaxBytes })
        throw new PlaybackBusyError('HLS storage is full. Close another player or use an external player.')
      }
      if (replaces) stop(replaces, 'replaced')
      const id = randomBytes(8).toString('hex')
      const folder = path.join(dir, id)
      fs.mkdirSync(folder)
      const duration = info.duration ?? null
      const plan = duration
        ? mode === 'transcode' ? fixedPlan(duration, info.startTime) : keyframes?.length ? keyframePlan(keyframes, duration, info.startTime) : null
        : null
      const startSegment = plan ? segmentAt(plan.starts, at) : 0
      const s: Session = {
        id,
        mode,
        producer,
        encoder: producer === 'node' ? 'node' : mode === 'transcode' ? resolvedEncoder : 'copy',
        dir: folder,
        input,
        info,
        audio,
        plan,
        growing: !plan,
        starts: plan ? plan.starts : [0],
        ended: false,
        end: 0,
        initFile: null,
        initInfo: null,
        segments: new Map(),
        refs: new Map(),
        sizes: new Map(),
        run: null,
        runs: 0,
        position: plan ? at : 0,
        demand: plan?.starts[startSegment] ?? 0,
        lastSeen: Date.now(),
        failure: null,
        waiters: new Set(),
        startSegment,
        skew: plan?.keyframes.length && producer === 'ffmpeg' ? null : 0,
        ready: false,
        onReady,
        stopped: false,
        log: (context?.logger ?? logger).child({ component: 'hls', sessionId: id, mode, producer }),
        started: performance.now(),
        get paused () { return this.run?.paused ?? false },
      }
      sessions.set(id, s)
      s.log.info('hls.created', { replacesSessionId: replaces, startSeconds: at, segments: plan?.starts.length ?? null, growing: !plan, encoder: s.encoder })
      startRun(s, startSegment)
      return s
    },
    get: id => sessions.get(id),
    touch,
    stats (session, now = Date.now()) {
      const s = session as Session // every HlsSession is a Session; a stopped one still reports its last state
      const run = s.run
      const ranges = readyRanges(s)
      const here = ranges.find(([a, b]) => s.position >= a - TIME_TOLERANCE && s.position < b)
      return {
        id: s.id,
        mode: s.mode,
        encoder: s.encoder,
        speed: run?.speed ?? null,
        fps: run?.fps ?? null,
        cpu: run ? sampleCpu(run, now) : null,
        produced: run?.latest ?? here?.[1] ?? 0,
        readyUntil: here?.[1] ?? s.position,
        ready: ranges,
        growing: s.growing,
        paused: run?.paused ?? false,
        running: !!run && run.exitCode === null,
        failed: !!s.failure,
        error: s.failure,
      }
    },
    async playlist (id, signal) {
      const s = sessionOr404(id)
      if (s.plan) return renderPlaylist({ starts: s.starts, end: s.plan.duration, vod: true, ended: true })
      while (!s.segments.has(0) && !s.ended) {
        if (s.failure) throw new HlsFailedError(s.failure)
        await wait(s, 0, signal)
      }
      // A growing playlist lists the segments published so far
      const published = s.ended ? s.starts.length : s.starts.length - 1
      return renderPlaylist({ starts: s.starts.slice(0, published), end: s.ended ? s.end : (s.starts[published] ?? 0), vod: false, ended: s.ended })
    },
    async init (id, signal) {
      const s = sessionOr404(id)
      if (!s.initFile) {
        if (s.failure) throw new HlsFailedError(s.failure)
        if (!s.run || s.run.exitCode !== null) ensureProducing(s, s.startSegment)
        await wait(s, 'init', signal)
      }
      return s.initFile!
    },
    async segment (id, k, signal) {
      const s = sessionOr404(id)
      if (!Number.isInteger(k) || k < 0 || k >= s.starts.length) throw new HlsNotFoundError('No such segment')
      s.demand = s.starts[k] ?? 0
      for (;;) {
        const seg = s.segments.get(k)
        if (seg) return seg.files
        if (s.failure) throw new HlsFailedError(s.failure)
        ensureProducing(s, k)
        await wait(s, k, signal)
      }
    },
    subtitles (id, track) {
      const s = sessionOr404(id)
      if (!s.info.subtitles.some(t => t.index === track && t.text)) throw new HlsNotFoundError('No such subtitle track')
      // Each run wrote its own part; overlapping cues repeat, which the player removes
      const parts: string[] = []
      for (let n = 0; n < s.runs; n++) {
        try { parts.push(fs.readFileSync(path.join(s.dir, `run${n}`, `sub_${track}.vtt`), 'utf8').replace(/^\uFEFF?WEBVTT[^\n]*\n/, '')) } catch {}
      }
      return `WEBVTT\n${parts.join('\n')}`
    },
    stop,
    stopAll: () => stopAll(),
    summary () {
      const running = [...sessions.values()].filter(s => !s.failure)
      return { active: running.length, bytes: running.reduce((sum, s) => sum + bytesOf(s), 0) }
    },
    checkResources,
    async close () {
      clearInterval(reaper)
      clearInterval(checker)
      stopAll('shutdown')
      await resourceCheck?.catch(() => {})
      await Promise.all(removals)
    },
  }
}
