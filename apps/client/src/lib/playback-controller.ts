// The Player's playback engine, with no rendering: asks the server how to play a file and drives the video element
// directly from /raw, through hls.js, or through an in-page browser remux. It owns sessions and tab fencing, subtitles,
// status polling, progress saves, remembered preferences and the next-episode countdown. A view subscribes and draws
// getSnapshot(); commands are its methods. In every mode video.currentTime is the position in the file.
//
// Lifetimes (docs/lifecycle.md): one AbortController per activation (activate() to suspend()), per playback attempt
// (the first start, an audio switch or a retry; teardown aborts it) and per subtitle selection. Async work checks
// only its own signal.
import type Hls from 'hls.js'
import type { BrowserCapabilities, PlaybackDecision, ProbeResult, TorrentFileInfo, TorrentInfo, TorrentStatus } from '@magplay/api-contract'
import { api } from './api.ts'
import type { ApiError } from './api.ts'
import type { BrowserRemux, BrowserRemuxOptions, BrowserRemuxStats } from './browser-remux.ts'
import { browserCanRemux, measureCaps } from './capabilities.ts'
import { pickByLanguage } from './naming.ts'
import { record } from './perf-samples.ts'
import type { PerfSample } from './perf-samples.ts'
import type { PlaybackAction, PlaybackPhase, PlaybackProblem, PlaybackSignals } from './playback-status.ts'
import { savedSpeed, speedLabel, steppedSpeed } from './player-speed.ts'
import { preferredSubtitle, subtitleOptions } from './player-tracks.ts'
import type { SubtitleOption } from './player-tracks.ts'
import { progressEntry, progressKey, resumePosition } from './progress.ts'
import { serialLatest, delay as sleep } from './requests.ts'
import { seekTarget, spans } from './seek.ts'
import type { Span } from './seek.ts'
import { parseVtt } from './subtitles.ts'
import { episodeLabel, formatClock as clock } from './format.ts'
import { recall, remember } from './storage.ts'
import { baseName, urls } from './urls.ts'

/** The server's decision for the current session; `complete` is set while no ffmpeg is running for it. */
export type Current = PlaybackDecision & { complete?: boolean }
/** A rejected play() or a failed request: DOMException, ApiError or a network error. */
type Failure = Partial<ApiError> & { name: string, message: string }

/** What covers the video: a chip ('busy' spinner, 'notice', 'warn') or a card that waits for an answer. */
export type Overlay =
  | { kind: 'busy' | 'notice' | 'warn', text: string }
  | { kind: 'resume', at: number }
  | { kind: 'countdown', next: TorrentFileInfo, left: number }
  | { kind: 'missing', message: string }

export interface MediaState {
  /** Where playback is, or before the media has loaded, where it was asked to start. */
  position: number
  /** The whole file's duration, 0 while unknown. */
  duration: number
  /** Seconds the browser has buffered past the playhead. */
  ahead: number
  buffered: Span[]
  paused: boolean
  readyState: number
  rate: number
  volume: number
  muted: boolean
  pip: boolean
  pipAllowed: boolean
}

export interface PlayerSnapshot {
  ih: string
  idx: number
  /** When this snapshot was taken; it is taken again at least every second while active. */
  now: number
  active: boolean
  phase: PlaybackPhase
  problem: PlaybackProblem | null
  /** What the busy spinner says until playback resumes ("Switching audio…"). */
  starting: string
  waitingAt: number
  statusAt: number
  slowSamples: number
  decision: Current | null
  info: ProbeResult | null
  torrent: TorrentInfo | null
  /** This file's entry in the torrent's file list. */
  file: TorrentFileInfo | null
  /** The next video in the torrent, if any. */
  next: TorrentFileInfo | null
  audio: number
  subtitleOptions: readonly SubtitleOption[]
  /** '' (off), 'embedded:<n>' or 'file:<idx>'. */
  subtitles: string
  /** The latest status poll for the current session. */
  status: TorrentStatus | null
  /** The latest source-only observation, kept through a seek or a restart. */
  source: { status: Extract<TorrentStatus, { loaded: true }>, at: number } | null
  /** The last 3 minutes of status polls, for the Performance lanes. */
  history: readonly PerfSample[]
  remux: BrowserRemuxStats | null
  overlay: Overlay | null
  /** How far a growing HLS playlist can be seeked; null for other files. */
  growingEnd: number | null
  media: MediaState
}

export interface PlaybackDeps {
  api: typeof api
  fetch: typeof fetch
  beacon: (url: string) => void
  loadHls: () => Promise<typeof Hls>
  startBrowserRemux: (video: HTMLVideoElement, options: BrowserRemuxOptions) => Promise<BrowserRemux>
  caps: BrowserCapabilities
  browserRemux: boolean
  mediaSession: MediaSession | null
}

export interface PlaybackOptions {
  ih: string
  idx: number
  video: HTMLVideoElement
  /** Leaves for another file's page (the next episode). */
  navigate?: (url: string) => void
  deps?: Partial<PlaybackDeps>
}

// Remembered choices, in localStorage through recall()/remember() (stored as "magplay:<key>"):
//   player:volume            0–1
//   player:muted             true | false
//   player:speed             playback rate, 1 = normal
//   player:audioLanguage     language code of the last chosen audio track ("eng"), or null
//   player:subtitleLanguage  language code of the last chosen subtitles, "off", or "any" for a track without a language
const PREF = { volume: 'player:volume', muted: 'player:muted', speed: 'player:speed', audio: 'player:audioLanguage', subtitles: 'player:subtitleLanguage' }

const newTab = (): string => Math.random().toString(36).slice(2)
const errorMessage = (err: unknown): string => err instanceof Error ? err.message : String(err)
export const fileLabel = (f: TorrentFileInfo): string => episodeLabel(f) || baseName(f.name)

/** Direct and browser-remux play the whole file's timeline locally: no server session, seeking inside the browser. */
export const isLocal = (decision: { mode: string } | null | undefined): boolean => decision?.mode === 'direct' || decision?.mode === 'browser-remux'
/** The file's ranges on the server, from the latest poll. */
export const fileRanges = (s: PlayerSnapshot): Array<[number, number]> | null => s.status?.loaded ? s.status.file?.ranges ?? null : null
/** The current HLS session's status from the latest poll. */
export const sessionStatus = (s: Pick<PlayerSnapshot, 'decision' | 'status'>): TorrentStatus['session'] =>
  s.decision?.session && s.status?.session?.id === s.decision.session ? s.status.session : null
/** Before a session has loaded any media there is nothing to play or pause. */
export const nothingToPlay = (s: PlayerSnapshot): boolean => ['loading', 'starting', 'playlist', 'error', 'idle'].includes(s.phase) && s.media.readyState === 0

/** The diagnosis inputs for playbackPresentation(). */
export function playbackSignals (s: PlayerSnapshot): PlaybackSignals {
  return {
    phase: s.phase,
    decision: s.decision,
    status: s.status,
    statusAge: s.statusAt ? s.now - s.statusAt : s.now - s.waitingAt,
    waitingMs: s.now - s.waitingAt,
    buffer: s.media.ahead,
    position: s.media.position,
    rate: s.media.rate,
    slowSamples: s.slowSamples,
    problem: s.problem,
    ...(s.source ? { source: { status: s.source.status, age: s.now - s.source.at } } : {}),
    ...(s.remux ? { remux: s.remux } : {}),
  }
}

export class PlaybackController {
  readonly ih: string
  readonly idx: number
  private readonly video: HTMLVideoElement
  private readonly deps: PlaybackDeps
  private readonly navigate: (url: string) => void
  private readonly listeners = new Set<() => void>()
  private readonly requestPlayback = serialLatest()
  /** The video and page listeners, until dispose(). */
  private readonly events = new AbortController()
  private readonly subTrack: TextTrack

  private tab = newTab()
  private activation = new AbortController()
  private active = false
  private attempt: AbortController | null = null
  private subtitleLife: AbortController | null = null
  private cancelNext = (): void => {}
  private lastProgressSave = 0
  private resumeAt = 0
  private hls: Hls | null = null
  private remux: BrowserRemux | null = null

  private info: ProbeResult | null = null
  private decision: Current | null = null
  private torrent: TorrentInfo | null = null
  private file: TorrentFileInfo | null = null
  private next: TorrentFileInfo | null = null
  private audio = 0
  private pendingPosition = 0 // the intended position while a replacement request is in flight
  private deferredSeek = 0 // a growing playlist starts at the beginning: where to jump once it has been converted that far
  private starting = ''
  private status: TorrentStatus | null = null
  private statusAt = 0
  private source: PlayerSnapshot['source'] = null
  private history: readonly PerfSample[] = []
  private stalled = false // waiting for data right now
  private stallSeen = false // waited at some point since the last sample
  private phase: PlaybackPhase = 'loading'
  private problem: PlaybackProblem | null = null
  private waitingAt = Date.now()
  private slowSamples = 0
  private subtitles = ''
  private lastSubtitles = '' // the last track turned on, for C
  private subtitleChoices: SubtitleOption[] = []
  private overlay: Overlay | null = null
  private autoMuted = false // muted by the autoplay fallback, not by choice

  private snapshot: PlayerSnapshot | null = null
  private notifying = false

  constructor ({ ih, idx, video, navigate = url => { location.href = url }, deps = {} }: PlaybackOptions) {
    this.ih = ih
    this.idx = idx
    this.video = video
    this.navigate = navigate
    this.deps = {
      api,
      fetch: (...args) => fetch(...args),
      beacon: url => { navigator.sendBeacon(url) },
      loadHls: async () => (await import('hls.js')).default,
      startBrowserRemux: async (...args) => (await import('./browser-remux.ts')).startBrowserRemux(...args),
      ...deps,
      caps: deps.caps ?? measureCaps(video, window),
      browserRemux: deps.browserRemux ?? browserCanRemux(window),
      mediaSession: deps.mediaSession !== undefined ? deps.mediaSession : 'mediaSession' in navigator ? navigator.mediaSession : null,
    }
    this.subTrack = video.addTextTrack('subtitles', 'Subtitles')
    this.listen()
    // Remembered volume, mute and speed; native controls stay off in every mode
    video.controls = false
    const volume = recall(PREF.volume)
    if (typeof volume === 'number' && volume >= 0 && volume <= 1) video.volume = volume
    video.muted = recall(PREF.muted) === true
    this.setSpeed(savedSpeed(recall(PREF.speed)), false)
    this.mediaActions({
      play: () => { video.play().catch(console.error) },
      pause: () => { video.pause() },
      seekbackward: d => { this.seekBy(-(d.seekOffset || 10)) },
      seekforward: d => { this.seekBy(d.seekOffset || 10) },
    })
  }

  // Store ---------------------------------------------------------------------

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  getSnapshot = (): PlayerSnapshot => {
    this.snapshot ??= this.takeSnapshot()
    return this.snapshot
  }

  /** Something changed: the next getSnapshot() takes a new snapshot, and subscribers hear about it once per task. */
  private changed (): void {
    this.snapshot = null
    if (this.notifying) return
    this.notifying = true
    queueMicrotask(() => {
      this.notifying = false
      for (const listener of this.listeners) listener()
    })
  }

  private takeSnapshot (): PlayerSnapshot {
    const v = this.video
    const buffered = spans(v.buffered)
    const range = buffered.find(([a, b]) => v.currentTime >= a - 0.5 && v.currentTime <= b)
    return {
      ih: this.ih,
      idx: this.idx,
      now: Date.now(),
      active: this.active,
      phase: this.phase,
      problem: this.problem,
      starting: this.starting,
      waitingAt: this.waitingAt,
      statusAt: this.statusAt,
      slowSamples: this.slowSamples,
      decision: this.decision,
      info: this.info,
      torrent: this.torrent,
      file: this.file,
      next: this.next,
      audio: this.audio,
      subtitleOptions: this.subtitleChoices,
      subtitles: this.subtitles,
      status: this.status,
      source: this.source,
      history: this.history,
      remux: this.remux?.stats() ?? null,
      overlay: this.overlay,
      growingEnd: this.growingEnd(),
      media: {
        position: this.position(),
        duration: this.duration(),
        ahead: range ? range[1] - v.currentTime : 0,
        buffered,
        paused: v.paused,
        readyState: v.readyState,
        rate: v.playbackRate,
        volume: v.volume,
        muted: v.muted,
        pip: typeof document !== 'undefined' && !!document.pictureInPictureElement,
        pipAllowed: typeof document !== 'undefined' && document.pictureInPictureEnabled && !v.disablePictureInPicture,
      },
    }
  }

  // Lifetime ------------------------------------------------------------------

  /** Starts (or, after suspend(), restarts) this page activation: title, probe, playback and status polling. */
  activate (): void {
    if (this.active || this.events.signal.aborted) return
    if (this.activation.signal.aborted) {
      this.tab = newTab() // a restored activation is a new tab to the server
      this.activation = new AbortController()
    }
    this.active = true
    this.changed()
    this.tick().catch(console.error)
    if (!this.file) this.loadTitle().catch(console.error)
    if (this.info) this.start(this.resumeAt).catch(console.error)
    else this.loadInfo().catch(console.error)
    this.pollStatus().catch(console.error)
  }

  /** Leaves the page (pagehide, or the view going away): saves progress, stops all work and closes the server session. */
  suspend (): void {
    if (!this.active) return
    this.persistProgress(true)
    this.resumeAt = this.position()
    this.active = false
    this.activation.abort()
    this.teardown()
    this.deps.beacon(`/api/play/tab/${this.tab}`)
    this.decision = null
    this.changed()
  }

  /** suspend(), and for good: the controller can't be activated again. */
  dispose (): void {
    this.suspend()
    this.events.abort()
    this.listeners.clear()
    this.mediaActions({ play: null, pause: null, seekbackward: null, seekforward: null, nexttrack: null })
    this.subTrack.mode = 'disabled'
  }

  private listen (): void {
    const on = (type: string, handler: () => void): void => { this.video.addEventListener(type, handler, { signal: this.events.signal }) }
    const update = (): void => { this.changed() }
    on('timeupdate', () => { this.persistProgress(); this.changed() })
    on('progress', update)
    on('durationchange', update)
    on('play', update)
    on('enterpictureinpicture', update)
    on('leavepictureinpicture', update)
    on('pause', () => {
      this.persistProgress(true)
      if (this.video.readyState >= 2 && !this.video.ended && ['playing', 'buffering'].includes(this.phase)) {
        this.stalled = false
        this.setPhase('paused')
      } else this.changed()
    })
    on('seeked', () => { this.persistProgress(true); this.changed() })
    on('ratechange', () => { this.slowSamples = 0; this.changed() })
    on('waiting', () => {
      if (!this.decision || ['paused', 'error', 'idle'].includes(this.phase)) return
      this.stalled = this.stallSeen = true
      this.setPhase('buffering')
    })
    on('playing', () => {
      if (this.activation.signal.aborted || this.phase === 'error') return
      this.starting = ''
      this.stalled = false
      this.persistProgress(true)
      this.problem = null
      this.setPhase('playing')
      // For "Continue" on the torrent page and the home page
      if (this.file) remember(`last:${this.ih}`, { idx: this.idx, label: fileLabel(this.file), at: Date.now() })
    })
    on('error', () => {
      if (isLocal(this.decision)) this.fail('Playback stopped', this.video.error?.message || `Media error ${this.video.error?.code}`)
    })
    on('ended', () => {
      this.persistProgress(true, true)
      this.setPhase('idle')
      this.countdownToNext()
    })
    on('volumechange', () => {
      if (!this.video.muted && this.overlay?.kind === 'notice') this.overlay = null
      this.changed()
    })
  }

  /** A new snapshot every second, so waiting times and the browser remux's progress stay current. */
  private async tick (): Promise<void> {
    const signal = this.activation.signal
    while (!signal.aborted) {
      this.changed()
      try { await sleep(1000, signal) } catch { return }
    }
  }

  // State helpers ---------------------------------------------------------------

  private setPhase (phase: PlaybackPhase): void {
    const settled = ['playing', 'paused', 'idle', 'error']
    if (!settled.includes(phase) && settled.includes(this.phase)) this.waitingAt = Date.now()
    this.phase = phase
    this.changed()
  }

  private fail (title: string, description: string, actions: PlaybackAction[] = ['retry', 'external']): void {
    this.problem = { title, description, actions }
    this.setPhase('error')
  }

  private setOverlay (overlay: Overlay | null): void {
    this.overlay = overlay
    this.changed()
  }

  /** A card that waits for an answer owns the stage, so the playback status steps aside. */
  private ask (overlay: Overlay): void {
    this.overlay = overlay
    this.setPhase('idle')
  }

  /** A file number this torrent doesn't have: retrying can't help. */
  private missingFile (err: Failure): void {
    this.ask({ kind: 'missing', message: err.message })
  }

  private position (): number {
    return this.decision && this.video.readyState > 0 ? this.video.currentTime : this.pendingPosition
  }

  /**
   * The whole file's duration, else the media's own: every mode plays on the file's timeline, and a growing playlist
   * of a file with no known duration is as long as it has been converted.
   */
  private duration (): number {
    return this.decision?.duration || this.info?.duration || (this.decision && Number.isFinite(this.video.duration) ? this.video.duration : 0)
  }

  /**
   * A growing HLS playlist (no keyframe index) can be seeked only as far as the server has converted; null for other
   * files. The browser's seekable range lags the server and isn't kept for a live playlist that has since ended.
   */
  private growingEnd (): number | null {
    const d = this.decision
    if ((d?.mode !== 'remux' && d?.mode !== 'transcode') || !d.growing) return null
    return Math.max(sessionStatus({ decision: d, status: this.status })?.ready.at(-1)?.[1] ?? 0, spans(this.video.seekable).at(-1)?.[1] ?? 0)
  }

  private bufferedAhead (): number {
    const now = this.video.currentTime
    const range = spans(this.video.buffered).find(([a, b]) => now >= a - 0.5 && now <= b)
    return range ? range[1] - now : 0
  }

  private persistProgress (force = false, ended = false): void {
    if (!this.decision || this.video.readyState < 2) return
    const now = Date.now()
    if (!force && now - this.lastProgressSave < 5000) return
    // A growing HLS playlist's local duration is not the whole file duration.
    const total = this.decision.duration ?? (isLocal(this.decision) ? this.video.duration : null)
    const entry = progressEntry(this.position(), total, { ended, at: now })
    if (entry) {
      remember(progressKey(this.ih, this.idx), entry)
      this.lastProgressSave = now
    }
  }

  private mediaActions (handlers: Partial<Record<MediaSessionAction, MediaSessionActionHandler | null>>): void {
    for (const [action, handler] of Object.entries(handlers)) {
      try { this.deps.mediaSession?.setActionHandler(action as MediaSessionAction, handler) } catch {} // older browsers lack some actions
    }
  }

  // Loading ---------------------------------------------------------------------

  /** The torrent's name and file list: the file's title, and the next episode. */
  private async loadTitle (): Promise<void> {
    const signal = this.activation.signal
    const t = await this.deps.api<TorrentInfo>(`/api/torrents/${this.ih}`, { signal }).catch(() => null)
    if (signal.aborted || !t) return
    this.torrent = t
    this.file = t.files.find(x => x.idx === this.idx) ?? null
    if (this.file) {
      // The file list is sorted by season and episode, so the next video is the next entry
      const videos = t.files.filter(f => f.isVideo)
      this.next = videos[videos.findIndex(f => f.idx === this.idx) + 1] ?? null
      const ep = episodeLabel(this.file)
      const name = baseName(this.file.name)
      if (this.deps.mediaSession) this.deps.mediaSession.metadata = new MediaMetadata({ title: ep ? `${ep} · ${name}` : name, artist: ep, album: t.name })
      this.mediaActions({ nexttrack: this.next ? () => { this.playNext() } : null })
    }
    this.changed()
  }

  private async loadInfo (): Promise<void> {
    const signal = this.activation.signal
    let probe: ProbeResult
    try {
      probe = await this.deps.api<ProbeResult>(`/api/probe/${this.ih}/${this.idx}`, { signal })
      if (signal.aborted) return
      this.info = probe
    } catch (error) {
      if (signal.aborted) return
      const err = error as Failure
      if (err.status === 404) return this.missingFile(err)
      return this.fail('Could not read the file', err.message, ['retry', 'external'])
    }
    // The remembered audio language picks the track, else track 1
    this.audio = pickByLanguage(probe.audio, recall(PREF.audio) as string | null)?.index ?? 0
    this.subtitleChoices = subtitleOptions(probe)
    // The remembered subtitle language turns subtitles on for this file when it has that language
    this.subtitles = this.lastSubtitles = preferredSubtitle(this.subtitleChoices, recall(PREF.subtitles))
    const saved = resumePosition(recall(progressKey(this.ih, this.idx)), probe.duration)
    this.pendingPosition = saved
    if (saved) this.ask({ kind: 'resume', at: saved })
    else this.start(0).catch(console.error)
    this.changed()
  }

  /** Every 2 s: keeps the ffmpeg session alive, feeds the seek bar and details, and notices when ffmpeg can't keep up. */
  private async pollStatus (): Promise<void> {
    const signal = this.activation.signal
    while (!signal.aborted) {
      const session = this.decision?.session
      const attempt = this.attempt
      const q = new URLSearchParams({ idx: String(this.idx), session: session ?? '', pos: String(this.video.currentTime) })
      const st = await this.deps.api<TorrentStatus>(`/api/torrents/${this.ih}/status?${q}`, { signal }).catch(() => null)
      if (signal.aborted) return
      // A poll that started before a restart describes the previous session
      if (st && attempt === this.attempt && this.decision?.session === session) this.applyStatus(st)
      else if (!st) this.slowSamples = 0
      this.changed()
      try { await sleep(2000, signal) } catch { return }
    }
  }

  private applyStatus (st: TorrentStatus): void {
    this.status = st
    this.statusAt = Date.now()
    if (st.loaded) this.source = { status: { ...st, session: null, preparation: null }, at: this.statusAt }
    const s = st.session
    this.slowSamples = st.loaded && st.file?.progress === 1 && s?.running && !s.paused && s.speed != null && s.speed < this.video.playbackRate ? this.slowSamples + 1 : 0
    if (s && this.decision) this.decision.complete = !s.running
    if (st.loaded && this.decision) {
      const history = [...this.history]
      record(history, {
        download: st.downloadSpeed,
        peers: st.peers.length,
        speed: s?.speed ?? null,
        fps: s?.fps ?? null,
        cpu: s?.cpu ?? null,
        paused: !!s?.paused,
        ahead: s ? Math.max(0, s.readyUntil - this.video.currentTime) : null,
        buffer: this.bufferedAhead(),
        stalled: this.stalled || this.stallSeen,
      })
      this.history = history
      this.stallSeen = false
    }
    if (this.deferredSeek && (this.growingEnd() ?? 0) > this.deferredSeek + 1) {
      this.video.currentTime = this.deferredSeek
      this.deferredSeek = 0
      this.overlay = null
    }
  }

  // Playback ----------------------------------------------------------------------

  private teardown (): void {
    this.attempt?.abort()
    this.subtitleLife?.abort()
    this.cancelNext()
    this.hls?.destroy()
    this.hls = null
    this.remux?.dispose()
    this.remux = null
    if (this.decision?.session) this.deps.beacon(`/api/play/${this.decision.session}`)
    this.video.removeAttribute('src')
    this.video.load()
  }

  /**
   * Asks the server how to play from `at` seconds and loads the result.
   * `message` is what the spinner says until the video plays again, such as "Switching audio…".
   */
  private async start (at = 0, message = ''): Promise<void> {
    if (!this.active) return
    const video = this.video
    this.pendingPosition = at
    this.starting = message
    this.teardown()
    const attempt = this.attempt = new AbortController()
    const signal = attempt.signal
    const current = (): boolean => !signal.aborted
    const tab = this.tab
    const pageSignal = this.activation.signal
    this.decision = null
    this.status = null
    this.statusAt = 0
    this.slowSamples = 0
    this.problem = null
    this.waitingAt = Date.now()
    this.overlay = null
    this.setPhase('starting')
    const { ih, idx, audio } = this
    let decision: Current
    try {
      const result = await this.requestPlayback(async () => {
        if (!current()) return null
        // Not cancelled by a newer attempt: playback requests change server state, so they finish in order
        const result = await this.deps.api<PlaybackDecision>('/api/play', { json: { ih, idx, audio, start: at, caps: this.deps.caps, browserRemux: this.deps.browserRemux, tab }, signal: pageSignal })
        if (!current()) {
          if (result.session) this.deps.beacon(`/api/play/${result.session}`)
          return null
        }
        return result
      })
      if (!current() || !result) return
      decision = this.decision = result
      this.status = null // discard polls from before this session existed
      this.statusAt = 0
    } catch (error) {
      if (!current()) return
      const err = error as Failure
      this.decision = null
      if (err.status === 404) return this.missingFile(err)
      return this.fail(err.status === 422 ? 'This browser cannot play this video' : 'Playback could not start', err.message,
        err.status === 422 ? ['external', 'release'] : ['retry', 'external'])
    }
    this.changed()

    const handlePlayError = (err: unknown): void => {
      if (!current()) return
      if (!(err instanceof Error) || err.name !== 'NotAllowedError') return this.fail('Playback could not start', errorMessage(err))
      // Browsers may block autoplay with sound until the page has been clicked; start muted then
      video.muted = true
      this.autoMuted = true
      video.play().then(() => { if (current()) this.setOverlay({ kind: 'notice', text: 'Muted: autoplay with sound was blocked. Click the video or press M to unmute.' }) },
        (err: unknown) => {
          if (!current()) return
          if (err instanceof Error && err.name === 'NotAllowedError') this.setPhase('blocked')
          else this.fail('Playback could not start', errorMessage(err))
        })
    }

    let play = true
    if (decision.mode === 'direct') {
      video.src = decision.url
      if (at) video.currentTime = at
    } else if (decision.mode === 'browser-remux') {
      this.setPhase('playlist')
      try {
        const started = await this.deps.startBrowserRemux(video, { url: decision.url, audio: decision.audio, duration: decision.duration, start: at, onError: (title, detail) => { if (current()) this.fail(title, detail) } })
        if (!current()) { started.dispose(); return }
        this.remux = started
      } catch (err) {
        if (current()) this.fail('This browser could not repackage the file', errorMessage(err), ['external', 'release'])
        return
      }
      if (at) video.currentTime = at
    } else {
      // The playlist covers the whole file, except a growing one, which starts at the beginning
      const from = decision.growing ? 0 : at
      this.deferredSeek = decision.growing ? at : 0
      if (this.deferredSeek) this.overlay = { kind: 'notice', text: `This file is converted from the start. Playback jumps to ${clock(at)} when conversion gets there.` }
      this.setPhase('playlist')
      // Safari plays HLS (and HEVC) natively; other browsers use hls.js
      const native = !!video.canPlayType('application/vnd.apple.mpegurl') && navigator.vendor.includes('Apple')
      const HlsPlayer = native ? null : await this.deps.loadHls()
      if (!current()) return
      if (!HlsPlayer?.isSupported()) {
        video.src = decision.url
        if (from) video.addEventListener('loadedmetadata', () => { if (current()) video.currentTime = from }, { once: true, signal })
      } else {
        // hls.js only attaches a media source after it has parsed the manifest, so
        // calling play() synchronously here can be lost on slower or incomplete streams.
        play = false
        // A segment the server hasn't converted yet answers once it has, which can take a while on a slow torrent
        const patient = { maxTimeToFirstByteMs: 120_000, maxLoadTimeMs: 300_000, timeoutRetry: { maxNumRetry: 2, retryDelayMs: 0, maxRetryDelayMs: 0 }, errorRetry: { maxNumRetry: 3, retryDelayMs: 1000, maxRetryDelayMs: 8000 } }
        const player = this.hls = new HlsPlayer({ startPosition: from, maxBufferLength: 60, fragLoadPolicy: { default: patient } })
        player.on(HlsPlayer.Events.ERROR, (_, data) => { if (current() && data.fatal) this.fail('Playback stopped', `Playback error: ${data.details}`) })
        player.on(HlsPlayer.Events.MANIFEST_PARSED, () => {
          if (current()) video.play().catch(handlePlayError)
        })
        player.loadSource(decision.url)
        player.attachMedia(video)
      }
    }
    this.changed()
    if (play) video.play().catch(handlePlayError)
    this.loadSubtitles().catch(console.error)
  }

  /** At the end of a video: play the next one after 10 s unless cancelled. */
  private countdownToNext (): void {
    this.cancelNext()
    const upcoming = this.next
    if (!upcoming || this.activation.signal.aborted) return
    const target = urls.player(this.ih, upcoming.idx)
    let left = 10
    const show = (): void => { this.ask({ kind: 'countdown', next: upcoming, left }) }
    const timer = setInterval(() => {
      if (--left <= 0) { cancel(); this.navigate(target) } else show()
    }, 1000)
    const cancel = (): void => {
      clearInterval(timer)
      this.video.removeEventListener('play', cancel)
      this.cancelNext = () => {}
      this.setOverlay(null)
    }
    this.cancelNext = cancel
    show()
    this.video.addEventListener('play', cancel, { once: true })
  }

  // Subtitles share one text track; all cues are on the file's timeline.
  private async loadSubtitles (): Promise<void> {
    this.subtitleLife?.abort()
    const signal = (this.subtitleLife = new AbortController()).signal
    for (const cue of [...(this.subTrack.cues ?? [])]) this.subTrack.removeCue(cue)
    const choice = this.subtitles
    this.subTrack.mode = choice ? 'showing' : 'hidden'
    const session = this.decision
    if (!choice || !session || this.attempt?.signal.aborted) return
    const [kind, n] = choice.split(':')
    let url: string | undefined
    if (kind === 'file') {
      url = `/subs/${this.ih}/${n}/file.vtt`
    } else if (session.mode === 'direct') {
      url = `/subs/${this.ih}/${this.idx}/${n}.vtt`
      this.setOverlay({ kind: 'busy', text: 'Extracting subtitles (needs the whole file downloaded)…' })
    } else if (session.mode === 'browser-remux') {
      return this.setOverlay({ kind: 'warn', text: 'Embedded subtitles need ffmpeg on the server; add an .srt file to the torrent folder.' })
    } else {
      url = session.subtitles.find(s => s.index === Number(n))?.url
    }
    if (!url) return
    const added = new Set<string>()
    // Session subtitles grow as ffmpeg converts more of the file, wherever it is asked to, so keep polling
    const live = url.startsWith('/hls/')
    for (;;) {
      const res = await this.deps.fetch(url, { cache: 'no-store', signal }).catch(() => null)
      if (signal.aborted) return
      const growing = live && !session.complete
      if (res?.ok) {
        let text
        try { text = await res.text() } catch {
          if (!signal.aborted) this.setOverlay({ kind: 'warn', text: 'Subtitle response was interrupted. Select the track again to retry.' })
          return
        }
        if (signal.aborted) return
        const cues = parseVtt(text)
        const ready = growing ? cues.slice(0, -1) : cues // the last cue may be half-written
        // Each ffmpeg run writes the cues of the part it converts, so the same cue can arrive twice
        for (const c of ready) {
          const key = `${c.from}|${c.to}|${c.text}`
          if (added.has(key)) continue
          added.add(key)
          this.subTrack.addCue(new VTTCue(c.from, c.to, c.text))
        }
        if (url.startsWith('/subs/')) this.setOverlay(null)
      } else if (!live) {
        const body = await res?.json().catch(() => null) as { error?: string } | null | undefined
        return this.setOverlay({ kind: 'warn', text: `Subtitles failed: ${body?.error || 'unknown error'}` })
      }
      if (!live) return
      try { await sleep(10_000, signal) } catch { return }
    }
  }

  // Commands ------------------------------------------------------------------------

  /** Plays from `at` seconds, such as the answer to the resume question. */
  playFrom (at: number): void {
    this.start(at).catch(console.error)
  }

  /** Forgets the saved position and plays from the beginning. */
  startOver (): void {
    remember(progressKey(this.ih, this.idx), progressEntry(0, this.info?.duration))
    this.playFrom(0)
  }

  /** The "Try again" action: the probe again if it failed, else playback from where it was. */
  retry (): void {
    if (this.info) return this.playFrom(this.position())
    this.problem = null
    this.waitingAt = Date.now()
    this.setPhase('loading')
    this.loadInfo().catch(console.error)
  }

  togglePlay (): void {
    if (nothingToPlay(this.getSnapshot())) return
    if (!this.video.paused) return this.video.pause()
    if (this.phase === 'paused' || this.phase === 'blocked') this.setPhase('buffering')
    this.video.play().catch((err: unknown) => {
      if (this.activation.signal.aborted) return
      if (err instanceof Error && err.name === 'NotAllowedError') this.setPhase('blocked')
      else this.fail('Playback could not start', errorMessage(err))
    })
  }

  /** A click on a video the autoplay fallback muted unmutes it instead of pausing. True if it did. */
  unmuteAutoplay (): boolean {
    if (!this.autoMuted || !this.video.muted) return false
    this.video.muted = false
    this.autoMuted = false
    return true
  }

  /** Jumps to `t`; the server, or a browser remux, converts from there if it must. */
  seek (t: number): void {
    if (!this.decision) return
    this.deferredSeek = 0
    this.video.currentTime = seekTarget(Math.max(0, Math.min(t, (this.duration() || Infinity) - 1)), this.growingEnd())
  }

  seekBy (seconds: number): void {
    this.seek(this.position() + seconds)
  }

  /** Switching audio restarts the session at the current position with the other track. */
  setAudio (index: number): void {
    if (index === this.audio) return
    this.audio = index
    remember(PREF.audio, this.info?.audio[index]?.language ?? null)
    this.start(this.position(), 'Switching audio…').catch(console.error)
  }

  /** Turns subtitles on with `choice`, or off with ''. Remembers the language for the next file unless `save` is false. */
  setSubtitles (choice: string, save = true): void {
    this.subtitles = choice
    const option = this.subtitleChoices.find(o => o.value === choice)
    if (choice) this.lastSubtitles = choice
    if (save) remember(PREF.subtitles, !choice ? 'off' : option?.language || 'any')
    this.changed()
    this.loadSubtitles().catch(console.error)
  }

  /** C: subtitles off, or back on with the last track used (the first text track if none was). */
  toggleSubtitles (): void {
    if (this.subtitles) return this.setSubtitles('')
    const choice = this.lastSubtitles || this.subtitleChoices.find(o => !o.disabled)?.value
    if (choice) this.setSubtitles(choice)
  }

  setSpeed (rate: number, save = true): void {
    this.video.defaultPlaybackRate = this.video.playbackRate = rate // the default survives loading a new session
    if (save) remember(PREF.speed, rate)
    this.slowSamples = 0
    this.changed()
  }

  /** < and >: one step slower or faster, said briefly on the video. */
  stepSpeed (direction: -1 | 1): void {
    const rate = steppedSpeed(this.video.playbackRate, direction)
    this.setSpeed(rate)
    const notice: Overlay = { kind: 'notice', text: `Speed ${speedLabel(rate)}` }
    this.setOverlay(notice)
    setTimeout(() => { if (this.overlay === notice) this.setOverlay(null) }, 1200)
  }

  /** Volume and mute are saved only when the viewer changes them, not by the autoplay fallback. */
  setVolume (value: number): void {
    const video = this.video
    video.volume = Math.max(0, Math.min(1, Math.round(value * 100) / 100))
    video.muted = video.volume === 0
    this.autoMuted = false
    remember(PREF.volume, video.volume)
    remember(PREF.muted, video.muted)
  }

  changeVolume (delta: number): void {
    this.setVolume((this.video.muted ? 0 : this.video.volume) + delta)
  }

  toggleMute (): void {
    const video = this.video
    if (video.muted && video.volume === 0) video.volume = 0.5
    video.muted = !video.muted
    this.autoMuted = false
    remember(PREF.muted, video.muted)
    remember(PREF.volume, video.volume)
  }

  togglePip (): void {
    if (this.video.disablePictureInPicture && !document.pictureInPictureElement) return
    const action = document.pictureInPictureElement ? document.exitPictureInPicture() : this.video.requestPictureInPicture()
    action.catch((err: unknown) => { this.setOverlay({ kind: 'warn', text: `Picture in picture: ${errorMessage(err)}` }) })
  }

  playNext (): void {
    if (this.next) this.navigate(urls.player(this.ih, this.next.idx))
  }

  cancelCountdown (): void {
    this.cancelNext()
  }
}
