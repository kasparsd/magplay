import { noopLogger, noopMetrics } from '@magplay/observability'
import type { Logger, Metrics, OperationContext } from '@magplay/observability'
// HLS sessions: one ffmpeg per player writing fMP4 segments into its own folder, throttled ahead of playback,
// reaped when idle and bounded by a session limit and a disk budget. Created by createHlsSessions(); close() stops all.
import { spawn } from 'node:child_process'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { SessionStats } from '@magplay/api-contract'
import { PlaybackBusyError } from './errors.ts'
import { ffmpegArgs, resolveTranscodeEncoder } from './media.ts'
import type { FfmpegArgsOptions } from './media.ts'

// Pause ffmpeg when it's this far ahead of the player, so the disk isn't filled with segments nobody watches yet
const AHEAD_PAUSE_S = 240
const AHEAD_RESUME_S = 120
// /proc/<pid>/stat counts CPU time in clock ticks; Linux uses 100 per second on every common platform
const CLOCK_TICKS = 100

/** ffmpeg publishes segments before atomically publishing their playlist.
 * Progress timestamps may be ahead of that playlist, so they are not readiness. */
function publishedSeconds (dir: string): number {
  try {
    const playlist = fs.readFileSync(path.join(dir, 'index.m3u8'), 'utf8')
    let seconds = 0
    let last = ''
    for (const match of playlist.matchAll(/#EXTINF:([\d.]+),[^\n]*\r?\n(seg_\d+\.m4s)/g)) {
      const duration = Number(match[1])
      if (!Number.isFinite(duration) || duration <= 0) return 0
      seconds += duration
      last = match[2] ?? ''
    }
    return last && fs.existsSync(path.join(dir, 'init.mp4')) && fs.existsSync(path.join(dir, last)) ? seconds : 0
  } catch { return 0 }
}

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

/** The ChildProcess surface sessions use, so tests can pass a stand-in. */
export type FfmpegProcess = Pick<ChildProcess, 'pid' | 'kill' | 'on'> & {
  stdout: NodeJS.ReadableStream
  stderr: NodeJS.ReadableStream
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
  /** A session nobody polled for this long is stopped. */
  idleMs?: number
  /** Called after a session is stopped, by any path. */
  onStop?: (id: string) => void
}

export interface StartOptions extends Pick<FfmpegArgsOptions, 'input' | 'info' | 'audio' | 'start' | 'mode'> {
  context?: OperationContext
  onReady?: () => void
  /** A session this one replaces: it doesn't count against the limit and is stopped once this one is admitted. */
  replaces?: string | undefined
}

export interface HlsSession {
  readonly id: string
  readonly mode: 'remux' | 'transcode'
  /** Seconds into the input where the session starts. */
  readonly start: number
  readonly dir: string
  /** Seconds of output ffmpeg has produced. */
  readonly outTime: number
  /** The player's position within the session output. */
  readonly position: number
  /** SIGSTOPped because it's far ahead of the player. */
  readonly paused: boolean
  /** Null while running; the exit code or signal, 'spawn-error' or 'resource-limit' after. */
  readonly exitCode: number | string | null
  /** The last lines of ffmpeg's stderr. */
  readonly stderr: readonly string[]
  /** Why the session was stopped by the disk budget, kept for status polls. */
  readonly failure: string | null
}

export interface HlsSessions {
  /** Starts ffmpeg, or throws PlaybackBusyError when the limit or disk budget doesn't allow another session. */
  start: (options: StartOptions) => HlsSession
  get: (id: string) => HlsSession | undefined
  /** Marks a session as alive; `position` is the player's time within the session output. */
  touch: (id: string, position?: number) => HlsSession | null
  stats: (session: HlsSession, now?: number) => SessionStats
  stop: (id: string, reason?: 'closed' | 'replaced' | 'idle' | 'shutdown' | 'cleared') => void
  /** Stops every session and deletes its output; returns how many there were. */
  stopAll: () => number
  /** Sessions running and their segment bytes, for the Debug page. */
  summary: () => { active: number, bytes: number }
  /** Soft disk budget: stops producers and reclaims their output. Runs on a timer; exposed for tests. */
  checkResources: () => Promise<void>
  /** Stops the timers and every ffmpeg (paused ones would outlive the server) and deletes the output. */
  close: () => Promise<void>
}

interface Session {
  id: string
  mode: 'remux' | 'transcode'
  start: number
  dir: string
  proc: FfmpegProcess
  lastSeen: number
  outTime: number
  speed: number | null
  fps: number | null
  position: number
  paused: boolean
  exitCode: number | string | null
  stderr: string[]
  failure: string | null
  bytes: number
  sizes: Map<string, number>
  cpuSample: { at: number, seconds: number }
  cpu: number | null
  log: Logger
  started: number
  ready: boolean
  stopReason: string | null
  terminal: boolean
  onReady: (() => void) | undefined
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

  function removeDir (folder: string): void {
    const removal: Promise<void> = fs.promises.rm(folder, { recursive: true, force: true })
      .catch((err: unknown) => logger.error('hls.cleanup.failed', { err }))
      .then(() => { removals.delete(removal) })
    removals.add(removal)
  }

  function throttle (s: Session): void {
    if (s.exitCode !== null) return
    const ahead = s.outTime - s.position
    if (!s.paused && ahead > AHEAD_PAUSE_S) { s.proc.kill('SIGSTOP'); s.paused = true }
    if (s.paused && ahead < AHEAD_RESUME_S) { s.proc.kill('SIGCONT'); s.paused = false }
  }

  function kill (s: Session): void {
    if (s.exitCode !== null) return
    if (s.paused) s.proc.kill('SIGCONT')
    s.proc.kill('SIGKILL')
  }

  function stop (id: string, reason: 'closed' | 'replaced' | 'idle' | 'shutdown' | 'cleared' = 'closed'): void {
    const s = sessions.get(id)
    if (!s) return
    sessions.delete(id)
    s.stopReason = reason
    s.log.info('hls.stopped', { stopReason: reason, durationMs: performance.now() - s.started, bytes: s.bytes })
    kill(s)
    removeDir(s.dir)
    onStop(id)
  }

  function touch (id: string, position?: number): Session | null {
    const s = sessions.get(id)
    if (!s) return null
    s.lastSeen = Date.now()
    checkReady(s)
    if (position !== undefined && Number.isFinite(position) && position >= 0) s.position = Math.min(position, s.outTime)
    throttle(s)
    return s
  }

  /**
   * ffmpeg's share of all CPU cores since the previous call (0–1, so 1 means the server is saturated), or null when unknown.
   * Each status poll calls it once, so the window is the poll interval.
   */
  function sampleCpu (s: Session, now: number): number | null {
    if (s.exitCode !== null) return null
    const seconds = readCpu(s.proc.pid)
    if (seconds == null) return null
    const prev = s.cpuSample
    s.cpuSample = { at: now, seconds }
    // Polls closer together than this say more about timer jitter than load, so repeat the last value
    if (now - prev.at < 500) return s.cpu
    s.cpu = Math.max(0, Math.min(1, (seconds - prev.seconds) / ((now - prev.at) / 1000) / cores))
    return s.cpu
  }

  function start ({ input, info, audio, start: at, mode, replaces, context, onReady }: StartOptions): Session {
    const { maxSessions, minFreeBytes, hlsMaxBytes, ffmpegPath, transcodeMaxHeight, transcodeEncoder, vaapiDevice, detectedEncoders } = live()
    const resolvedEncoder = resolveTranscodeEncoder(transcodeEncoder, detectedEncoders ?? [])
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
    const used = [...sessions.values()].reduce((sum, s) => sum + s.bytes, 0)
    if (used >= hlsMaxBytes) {
      metrics.reject('disk', 'storage')
      logger.warn('resource.rejected', { resource: 'disk', reason: 'storage', used, limit: hlsMaxBytes })
      throw new PlaybackBusyError('HLS storage is full. Close another player or use an external player.')
    }
    if (replaces) stop(replaces, 'replaced')
    const id = randomBytes(8).toString('hex')
    const folder = path.join(dir, id)
    fs.mkdirSync(folder)
    const args = ffmpegArgs({ input, info, audio, start: at, mode, dir: folder, transcodeMaxHeight, transcodeEncoder: resolvedEncoder, ...(vaapiDevice ? { vaapiDevice } : {}) })
    const proc = spawnProcess(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    // CPU use is the CPU-time delta between two status polls; the first poll measures from the spawn
    const s: Session = {
      id,
      mode,
      start: at,
      dir: folder,
      proc,
      lastSeen: Date.now(),
      outTime: 0,
      speed: null,
      fps: null,
      position: 0,
      paused: false,
      exitCode: null,
      stderr: [],
      failure: null,
      bytes: 0,
      sizes: new Map(),
      cpuSample: { at: Date.now(), seconds: 0 },
      cpu: null,
      log: (context?.logger ?? logger).child({ component: 'hls', sessionId: id, mode }),
      started: performance.now(),
      ready: false,
      stopReason: null,
      terminal: false,
      onReady,
    }
    sessions.set(id, s)
    s.log.info('hls.created', { replacesSessionId: replaces, startSeconds: at, encoder: resolvedEncoder })

    let buf = ''
    proc.stdout.on('data', (chunk: Buffer | string) => {
      buf = (buf + String(chunk)).slice(-16384)
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        const [key, value = ''] = line.split('=')
        if ((key === 'out_time_us' || key === 'out_time_ms') && Number(value) >= 0) s.outTime = Number(value) / 1e6
        if (key === 'speed' && parseFloat(value)) s.speed = parseFloat(value)
        if (key === 'fps' && Number.isFinite(parseFloat(value))) s.fps = parseFloat(value)
        if (key === 'progress') { throttle(s); checkReady(s) }
      }
    })
    proc.stderr.on('data', (chunk: Buffer | string) => {
      s.stderr.push(...String(chunk).slice(-8192).trim().split('\n').slice(-20).map(line => line.slice(0, 1024)))
      s.stderr.splice(0, s.stderr.length - 20)
    })
    proc.on('error', (err: Error) => {
      s.exitCode = 'spawn-error'
      s.stderr.push(`Could not start ffmpeg: ${err.message}`)
      s.terminal = true
      metrics.job('conversion', 'failure', (performance.now() - s.started) / 1000)
      s.log.error('ffmpeg.spawn.failed', { err, durationMs: performance.now() - s.started })
    })
    proc.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      if (s.exitCode === null) s.exitCode = code ?? signal
      if (s.terminal) return
      s.terminal = true
      metrics.job('conversion', s.stopReason ? s.stopReason === 'resource-limit' ? 'rejected' : 'cancelled' : code === 0 ? 'success' : 'failure', (performance.now() - s.started) / 1000)
      checkReady(s)
      s.log[!s.stopReason && s.exitCode !== 0 ? 'error' : 'info']('ffmpeg.exited', { code: code ?? signal, stopReason: s.stopReason, speed: s.speed, fps: s.fps, outputSeconds: s.outTime, durationMs: performance.now() - s.started, ...(!s.stopReason && code !== 0 ? { stderr: s.stderr.slice(-3).join('\n') } : {}) })
    })
    return s
  }

  function checkReady (s: Session): void {
    if (s.ready || s.stopReason) return
    const seconds = publishedSeconds(s.dir)
    if (seconds <= 0) return
    s.ready = true
    s.log.info('hls.media.published', { durationMs: performance.now() - s.started, outputSeconds: seconds })
    s.onReady?.()
    s.onReady = undefined
  }

  async function sessionBytes (s: Session): Promise<number> {
    const entries = await fs.promises.readdir(s.dir, { withFileTypes: true }).catch((err: unknown) => {
      if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return []
      throw err
    })
    const present = new Set<string>()
    await Promise.all(entries.filter(e => e.isFile()).map(async e => {
      present.add(e.name)
      // Published segments never change. Only new segments, init, VTT and growing
      // temporary files need stat calls on subsequent checks.
      if (e.name.endsWith('.m4s') && s.sizes.has(e.name)) return
      const stat = await fs.promises.stat(path.join(s.dir, e.name)).catch((err: unknown) => {
        if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return null // ffmpeg just renamed/deleted it
        throw err
      })
      s.sizes.set(e.name, stat?.size || 0)
    }))
    for (const name of s.sizes.keys()) if (!present.has(name)) s.sizes.delete(name)
    return [...s.sizes.values()].reduce((sum, n) => sum + n, 0)
  }

  let resourceCheck: Promise<void> | null = null
  function checkResources (): Promise<void> {
    resourceCheck ??= (async () => {
      const all = [...sessions.values()].filter(s => !s.failure)
      if (!all.length) return
      await Promise.all(all.map(async s => { s.bytes = await sessionBytes(s); checkReady(s) }))
      const disk = await fs.promises.statfs(dir)
      const total = all.reduce((sum, s) => sum + s.bytes, 0)
      const { hlsMaxBytes, minFreeBytes } = live()
      let reclaim = Math.max(total - hlsMaxBytes, minFreeBytes - disk.bavail * disk.bsize)
      if (reclaim <= 0) return
      // Largest output first; retain the failed session record so status polling
      // reports a useful error instead of silently forgetting the player's work.
      for (const s of all.sort((a, b) => b.bytes - a.bytes)) {
        if (reclaim <= 0) break
        if (!sessions.has(s.id)) continue
        s.stopReason = 'resource-limit'
        s.log.warn('hls.resource.stopped', { reason: 'storage', bytes: s.bytes })
        kill(s)
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
    start,
    get: id => sessions.get(id),
    touch,
    stats (session, now = Date.now()) {
      // Every HlsSession is a Session; a stopped one still reports its last state
      const s = session as Session
      checkReady(s)
      return {
        id: s.id,
        mode: s.mode,
        speed: s.speed,
        fps: s.fps,
        cpu: sampleCpu(s, now),
        produced: s.outTime,
        readyUntil: publishedSeconds(s.dir),
        paused: s.paused,
        running: s.exitCode === null,
        failed: s.exitCode !== null && s.exitCode !== 0,
        error: s.failure || (s.exitCode ? s.stderr.slice(-3).join('\n') : null),
      }
    },
    stop,
    stopAll: () => stopAll(),
    summary () {
      const running = [...sessions.values()].filter(s => !s.failure)
      return { active: running.length, bytes: running.reduce((sum, s) => sum + s.bytes, 0) }
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
