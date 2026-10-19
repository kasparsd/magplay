import Hls from 'hls.js'
// The player page, /play/<infohash>/<file index>. One chrome over the video for every playback mode:
// direct files play from /raw, remux and transcode through an HLS session whose timeline starts at cur.offset.
import type { PlaybackDecision, ProbeResult, TorrentFileInfo, TorrentInfo, TorrentStatus } from '@magplay/api-contract'
import { api } from './lib/api.ts'
import type { ApiError } from './lib/api.ts'
import { measureCaps } from './lib/capabilities.ts'
import { icon } from './lib/icons.ts'
import { pickByLanguage, releaseName } from './lib/naming.ts'
import { performanceView, record } from './lib/performance.ts'
import type { PerfSample } from './lib/performance.ts'
import { factRows } from './lib/player-facts.ts'
import { keyCommand } from './lib/player-keys.ts'
import type { PlayerCommand } from './lib/player-keys.ts'
import { SPEEDS, savedSpeed, speedLabel, steppedSpeed } from './lib/player-speed.ts'
import { audioTrackLabel, audioTrackName, preferredSubtitle, subtitleOptions } from './lib/player-tracks.ts'
import type { SubtitleOption } from './lib/player-tracks.ts'
import { parseVtt } from './lib/subtitles.ts'
import { progressKey, progressEntry, resumePosition } from './lib/progress.ts'
import { canSeekLocally, layerBackground, seekHint, seekOutcome, spans } from './lib/seek.ts'
import { $, copyButton, el, episodeLabel, fill, formatClock as clock, menu, menuChoice, menuHeading, menuSeparator, recall, remember } from './lib/ui.ts'
import type { Child } from './lib/ui.ts'
import { baseName, playerApps, streamUrl, urls } from './lib/urls.ts'

import { serialLatest, delay as sleep } from './lib/requests.ts'
import { playbackPresentation } from './lib/playback-flow.ts'
import type { PlaybackAction, PlaybackPhase, PlaybackProblem } from './lib/playback-status.ts'
import { playbackStatusView } from './lib/playback-status-view.ts'
import './lib/topbar.ts'

/** The server's decision for the current session; `complete` is set once its ffmpeg has finished. */
type Current = PlaybackDecision & { complete?: boolean }
/** A rejected play() or a failed request: DOMException, ApiError or a network error. */
type Failure = Partial<ApiError> & { name: string, message: string }

const requestPlayback = serialLatest()
const video = $<HTMLVideoElement>('#video')
const stage = $('#stage')
const [, , ih = '', idxPart] = location.pathname.split('/')
const idx = Number(idxPart)
let tab = Math.random().toString(36).slice(2) // new id for each document activation
let pageLife = new AbortController()
let playLife: AbortController | null = null
let subtitleLife: AbortController | null = null
let cancelNext = (): void => {}
let lastProgressSave = 0

let info: ProbeResult | null = null
let cur: Current | null = null
let hls: Hls | null = null
let audio = 0
let generation = 0 // bumped on every (re)start so stale async work stops
let pendingPosition = 0 // keep the intended position while a replacement request is in flight
let starting = '' // what the busy spinner says until playback resumes ("Starting at 14:20…")
let searchTitle = ''
let file: TorrentFileInfo | undefined // this file's entry from the torrent's file list
let next: TorrentFileInfo | null = null // the next video in the torrent, if any
let lastStatus: TorrentStatus | null = null // the latest /status poll, for the details panel and the seek bar
let sourceSnapshot: { status: Extract<TorrentStatus, { loaded: true }>, at: number } | null = null
const history: PerfSample[] = [] // the last 3 minutes of status polls, for the Performance lanes
let stalled = false // waiting for data right now
let stallSeen = false // waited at some point since the last sample
let playbackPhase: PlaybackPhase = 'loading'
let playbackProblem: PlaybackProblem | null = null
let waitingAt = Date.now()
let statusAt = 0
let slowSamples = 0
let flowPinned = false
const subTrack = video.addTextTrack('subtitles', 'Subtitles')
const showPlaybackStatus = playbackStatusView($('#playback-status'), $('#playback-announcement'), name => {
  if (name === 'retry') return button('Try again', () => { if (info) start(position()).catch(console.error); else retryInfo() }, true)
  if (name === 'play') return button('Play', togglePlay, true)
  if (name === 'release') return linkButton('Choose another release', urls.search(searchTitle))
  if (!file) return null
  return menu('Open in player', [
    ...playerApps(ih, idx, file.name).map(([text, href]) => el('a', { textContent: text, href })),
    copyButton('Copy stream link', streamUrl(ih, idx, file.name)),
  ], { className: 'button playback-external' })
}, toggleFlowPin)

function toggleFlowPin (): void {
  flowPinned = !flowPinned
  renderPlaybackStatus()
  renderMore()
  wake()
}

/** The file's ranges on the server, from the latest poll. */
const fileRanges = (): Array<[number, number]> | null => lastStatus?.loaded ? lastStatus.file?.ranges ?? null : null

function setPlaybackPhase (phase: PlaybackPhase): void {
  if (!['playing', 'paused', 'idle', 'error'].includes(phase) && ['playing', 'paused', 'idle', 'error'].includes(playbackPhase)) waitingAt = Date.now()
  playbackPhase = phase
  renderPlaybackStatus()
}

function failPlayback (title: string, description: string, actions: PlaybackAction[] = ['retry', 'external']): void {
  playbackProblem = { title, description, actions }
  setPlaybackPhase('error')
}

function renderPlaybackStatus (): void {
  if (pageLife.signal.aborted) return
  const now = Date.now()
  const model = playbackPresentation({
    phase: playbackPhase,
    decision: cur,
    status: lastStatus,
    statusAge: statusAt ? now - statusAt : now - waitingAt,
    waitingMs: now - waitingAt,
    buffer: bufferedAhead(),
    position: video.currentTime,
    rate: video.playbackRate,
    slowSamples,
    problem: playbackProblem,
    ...(sourceSnapshot ? { source: { status: sourceSnapshot.status, age: now - sourceSnapshot.at } } : {}),
  }, flowPinned)
  if (model && !file) model.actions = model.actions.filter(name => name !== 'external' && name !== 'release')
  showPlaybackStatus(model, now - waitingAt, starting ? `${starting} · Waiting ${Math.floor((now - waitingAt) / 1000)} s` : '')
  renderPlayButton()
  stage.classList.toggle('has-playback-wait', !!model && model.kind !== 'warning' && model.kind !== 'debug' && model.key !== 'brief')
  if (model && model.kind !== 'warning' && model.kind !== 'debug') stage.classList.remove('idle')
}

async function tickPlaybackStatus (signal = pageLife.signal): Promise<void> {
  while (!signal.aborted) {
    renderPlaybackStatus()
    try { await sleep(1000, signal) } catch { return }
  }
}

// Remembered choices, in localStorage through recall()/remember() (stored as "magplay:<key>"):
//   player:volume            0–1
//   player:muted             true | false
//   player:speed             playback rate, 1 = normal
//   player:audioLanguage     language code of the last chosen audio track ("eng"), or null
//   player:subtitleLanguage  language code of the last chosen subtitles, "off", or "any" for a track without a language
const PREF = { volume: 'player:volume', muted: 'player:muted', speed: 'player:speed', audio: 'player:audioLanguage', subtitles: 'player:subtitleLanguage' }

/**
 * Messages on the video itself: 'busy' (spinner in the middle), 'notice' and 'warn' (chips, with optional
 * link buttons), or a centred card with actions for errors and questions. An empty text clears it.
 */
function notify (text: string, kind: 'busy' | 'notice' | 'warn' | 'error' = 'notice', actions: HTMLElement[] = []): void {
  const overlay = $('#overlay')
  if (!text) return fill(overlay)
  if (kind === 'error') {
    setPlaybackPhase('idle') // resume/countdown prompts own the stage until answered
    return fill(overlay, el('div', { className: 'card' }, el('p', { textContent: text }), actions.length > 0 && el('p', { className: 'actions' }, ...actions)))
  }
  fill(overlay, el('div', { className: `toast ${kind}` }, text, ...actions))
}

const button = (label: string, onclick: () => void, primary?: boolean): HTMLButtonElement => el('button', { type: 'button', className: `button${primary ? ' primary' : ''}`, textContent: label, onclick })
const linkButton = (label: string, href: string, primary?: boolean): HTMLAnchorElement => el('a', { className: `button${primary ? ' primary' : ''}`, href, textContent: label })

/** A file number this torrent doesn't have: retrying can't help, so offer only the way back and hide the empty controls. */
function missingFile (err: Failure): void {
  for (const sel of ['#title-actions', '#details', '#performance', '#chrome']) $(sel).hidden = true
  return notify(err.message, 'error', [linkButton('Back to files', urls.torrent(ih), true)])
}

const fileLabel = (f: TorrentFileInfo): string => episodeLabel(f) || baseName(f.name)

/** Names the page after the file, links back to its torrent, offers external players and finds the next episode. */
async function loadTitle (signal = pageLife.signal): Promise<void> {
  $<HTMLAnchorElement>('#back').href = urls.torrent(ih)
  const t = await api<TorrentInfo>(`/api/torrents/${ih}`, { signal }).catch(() => null)
  if (signal.aborted) return
  file = t?.files.find(x => x.idx === idx)
  if (t) { $('#back').textContent = `← ${t.name}`; searchTitle = releaseName(t.name) }
  if (!t || !file) return
  // The title is the release's name and episode ("Fleabag · S01E01"); the file name is in Details
  const title = [releaseName(t.name), episodeLabel(file)].filter(Boolean).join(' · ')
  $('#title').textContent = title
  document.title = `${title} · magplay`
  $('#screen-name').textContent = title
  $('#screen-sub').textContent = baseName(file.name)
  fill($('#openin'), menu('Open in ▾', [
    menuHeading('Other players'),
    ...playerApps(ih, idx, file.name).map(([text, href, title = '']) => el('a', { href, title, textContent: text })),
    copyButton('Copy stream link', streamUrl(ih, idx, file.name), 'Copy the stream link for any player'),
  ], { className: 'button' }))
  // The file list is sorted by season and episode, so the next video is the next entry
  const videos = t.files.filter(f => f.isVideo)
  next = videos[videos.findIndex(f => f.idx === idx) + 1] ?? null
  if (next) {
    const name = `Next: ${fileLabel(next)}`
    const link = $<HTMLAnchorElement>('#next')
    Object.assign(link, { href: urls.player(ih, next.idx), title: `${name} (N)`, hidden: false })
    link.setAttribute('aria-label', name)
    fill(link, el('span', { className: 'pill wide-only', textContent: name }), el('span', { className: 'narrow-only' }, icon('next')))
  }
  renderMore()
  setMediaSession(t, file)
  renderFacts()
  renderPlaybackStatus()
}

/** At the end of a video: play the next one after 10 s unless cancelled. */
function countdownToNext (): void {
  cancelNext()
  if (!next || pageLife.signal.aborted) return
  const upcoming = next
  const target = urls.player(ih, upcoming.idx)
  let left = 10
  const timer = setInterval(() => {
    if (--left <= 0) { cancel(); location.href = target } else render()
  }, 1000)
  const cancel = (): void => {
    clearInterval(timer)
    video.removeEventListener('play', cancel)
    cancelNext = () => {}
    notify('')
  }
  cancelNext = cancel
  const render = (): void => notify(`Next: ${fileLabel(upcoming)} in ${left} s`, 'error',
    [linkButton('Play now', target, true), button('Cancel', cancel)])
  render()
  video.addEventListener('play', cancel, { once: true })
}

/** The ⓘ panel: how this file is being played, and how the torrent is doing. */
function renderFacts (): void {
  const rows = factRows({ decision: cur, file, info, audio, status: lastStatus, buffered: bufferedAhead() })
  fill($('#facts'), ...rows.flatMap(([k, value]) => [el('dt', { textContent: k }), el('dd', { textContent: value })]))
}

const caps = measureCaps(video, window)

const position = (): number => cur ? cur.offset + video.currentTime : pendingPosition
/** The whole file's duration: HLS sessions only know their own part, and direct decisions may not know it at all. */
const duration = (): number => cur?.duration || info?.duration || (cur?.mode === 'direct' && Number.isFinite(video.duration) ? video.duration : 0)
/** Seconds the browser has buffered past the playhead. */
function bufferedAhead (): number {
  const now = video.currentTime
  const range = spans(video.buffered).find(([a, b]) => now >= a - 0.5 && now <= b)
  return range ? range[1] - now : 0
}

function persistProgress (force = false, ended = false): void {
  if (!cur || video.readyState < 2) return
  const now = Date.now()
  if (!force && now - lastProgressSave < 5000) return
  // A growing HLS playlist's local duration is not the whole file duration.
  const total = cur.duration ?? (cur.mode === 'direct' ? video.duration : null)
  const entry = progressEntry(position(), total, { ended, at: now })
  if (entry) {
    remember(progressKey(ih, idx), entry)
    lastProgressSave = now
  }
}

function teardown (): void {
  playLife?.abort()
  subtitleLife?.abort()
  cancelNext()
  hls?.destroy()
  hls = null
  if (cur?.session) navigator.sendBeacon(`/api/play/${cur.session}`)
  video.removeAttribute('src')
  video.load()
}

/**
 * Asks the server how to play from `at` seconds and loads the result.
 * `message` is what the spinner says until the video plays again, such as "Starting at 14:20…".
 */
async function start (at = 0, message = ''): Promise<void> {
  if (pageLife.signal.aborted) return
  const gen = ++generation
  pendingPosition = at
  starting = message
  teardown()
  const signal = (playLife = new AbortController()).signal
  const requestTab = tab
  const pageSignal = pageLife.signal
  const current = (): boolean => gen === generation && !signal.aborted
  cur = null
  lastStatus = null
  statusAt = 0
  slowSamples = 0
  playbackProblem = null
  waitingAt = Date.now()
  notify('')
  setPlaybackPhase('starting')
  const selectedAudio = audio
  let decision: Current
  try {
    const result = await requestPlayback(async current => {
      if (gen !== generation) return null
      const result = await api<PlaybackDecision>('/api/play', { json: { ih, idx, audio: selectedAudio, start: at, caps, tab: requestTab }, signal: pageSignal })
      if (!current() || gen !== generation) {
        if (result.session) navigator.sendBeacon(`/api/play/${result.session}`)
        return null
      }
      return result
    })
    if (gen !== generation || !result) return
    decision = cur = result
    lastStatus = null // discard polls from before this session existed
    statusAt = 0
  } catch (error) {
    if (!current()) return
    const err = error as Failure
    cur = null
    if (err.status === 404) return missingFile(err)
    return failPlayback(err.status === 422 ? 'This browser cannot play this video' : 'Playback could not start', err.message,
      err.status === 422 ? ['external', 'release'] : ['retry', 'external'])
  }
  if (gen !== generation) return
  updateTimeline()

  let startPlayback = true
  if (decision.mode === 'direct') {
    video.src = decision.url
    if (at) video.currentTime = at
  } else {
    setPlaybackPhase('playlist')
    try {
      await waitForPlaylist(decision.url, gen, signal)
    } catch (err) {
      if (current()) failPlayback('The stream did not become ready', (err as Failure).message)
      return
    }
    if (gen !== generation) return
    // Safari plays HLS (and HEVC) natively; other browsers use hls.js
    if (!Hls.isSupported() || (navigator.vendor.includes('Apple') && video.canPlayType('application/vnd.apple.mpegurl'))) {
      video.src = decision.url
    } else {
      // hls.js only attaches a media source after it has parsed the manifest, so
      // calling play() synchronously here can be lost on slower or incomplete streams.
      startPlayback = false
      const player = hls = new Hls({ startPosition: 0, maxBufferLength: 60 })
      player.on(Hls.Events.ERROR, (_, data) => { if (current() && data.fatal) failPlayback('Playback stopped', `Playback error: ${data.details}`) })
      player.on(Hls.Events.MANIFEST_PARSED, () => {
        if (!current()) return
        video.play().catch(handlePlayError)
      })
      player.loadSource(decision.url)
      player.attachMedia(video)
    }
  }
  renderFacts()
  const handlePlayError = (err: unknown): void => {
    if (!current()) return
    if (!(err instanceof Error) || err.name !== 'NotAllowedError') return failPlayback('Playback could not start', err instanceof Error ? err.message : String(err))
    video.muted = true
    autoMuted = true
    video.play().then(() => { if (current()) notify('Muted: autoplay with sound was blocked. Click the video or press M to unmute.') },
      (err: unknown) => {
        if (!current()) return
        if (err instanceof Error && err.name === 'NotAllowedError') setPlaybackPhase('blocked')
        else failPlayback('Playback could not start', err instanceof Error ? err.message : String(err))
      })
  }
  // Browsers may block autoplay with sound until the page has been clicked; start muted then
  if (startPlayback) video.play().catch(handlePlayError)
  loadSubtitles(gen).catch(console.error)
}

async function waitForPlaylist (url: string, gen: number, signal: AbortSignal): Promise<void> {
  const until = Date.now() + 45_000
  while (Date.now() < until && gen === generation) { // eslint-disable-line no-unmodified-loop-condition -- generation is bumped by a new playlist load between polls
    const res = await fetch(url, { cache: 'no-store', signal })
    if (res.status === 500) throw new Error(await res.text())
    if (res.ok && /\.m4s/.test(await res.text())) return
    await sleep(1000, signal)
  }
  throw new Error('No playable segment became available within 45 s. Source data, conversion or stream delivery may be delayed. Try again or open the original file in another player.')
}

/** Jumps to absolute time `t`. The seek tooltip predicts the same outcome through seekOutcome(). */
function seekTo (t: number): void {
  if (!cur) return
  t = Math.max(0, Math.min(t, (duration() || Infinity) - 1))
  if (cur.mode === 'direct') {
    video.currentTime = t
    return
  }
  const rel = t - cur.offset
  // Only seek locally where the browser can actually land (see canSeekLocally); otherwise restart the session at the target
  if (canSeekLocally(rel, spans(video.seekable))) video.currentTime = rel
  else start(t, `Starting at ${clock(t)}…`).catch(console.error)
}

// Subtitles share one text track. Parsing is pure; polling, growing-file
// handling and HLS offset application remain owned by this page.
let subtitleRun = 0
let subsChoice = '' // '' (off), 'embedded:<n>' or 'file:<idx>'
let lastSubs = '' // the last track turned on, for C
let subOptions: SubtitleOption[] = []
async function loadSubtitles (gen = generation): Promise<void> {
  subtitleLife?.abort()
  const signal = (subtitleLife = new AbortController()).signal
  const run = ++subtitleRun
  for (const cue of [...(subTrack.cues ?? [])]) subTrack.removeCue(cue)
  const choice = subsChoice
  subTrack.mode = choice ? 'showing' : 'hidden'
  if (!choice || !cur) return
  const session = cur
  const [kind, n] = choice.split(':')
  let url: string | undefined
  let shift = 0
  if (kind === 'file') {
    url = `/subs/${ih}/${n}/file.vtt`
    shift = -session.offset // external files are timed from the start of the video
  } else if (session.mode === 'direct') {
    url = `/subs/${ih}/${idx}/${n}.vtt`
    notify('Extracting subtitles (needs the whole file downloaded)…', 'busy')
  } else {
    url = session.subtitles.find(s => s.index === Number(n))?.url
  }
  if (!url) return
  let added = 0
  // Session subtitles grow as ffmpeg works, so poll until it's done
  for (;;) {
    const res = await fetch(url, { cache: 'no-store', signal }).catch(() => null)
    if (signal.aborted || gen !== generation || run !== subtitleRun || subsChoice !== choice) return
    const growing = url.startsWith('/hls/') && !session.complete
    if (res?.ok) {
      let text
      try { text = await res.text() } catch {
        if (!signal.aborted) notify('Subtitle response was interrupted. Select the track again to retry.', 'warn')
        return
      }
      if (signal.aborted || gen !== generation || run !== subtitleRun || subsChoice !== choice) return
      const cues = parseVtt(text)
      const ready = growing ? cues.slice(0, -1) : cues // the last cue may be half-written
      for (const c of ready.slice(added)) subTrack.addCue(new VTTCue(c.from + shift, c.to + shift, c.text))
      added = Math.max(added, ready.length)
      if (url.startsWith('/subs/')) notify('')
    } else if (!growing) {
      const body = await res?.json().catch(() => null) as { error?: string } | null | undefined
      return notify(`Subtitles failed: ${body?.error || 'unknown error'}`, 'warn')
    }
    if (!growing) return
    try { await sleep(10_000, signal) } catch { return }
  }
}

/** Turns subtitles on with `choice`, or off with ''. Remembers the language for the next file unless `save` is false. */
function setSubtitles (choice: string, save = true): void {
  subsChoice = choice
  const option = subOptions.find(o => o.value === choice)
  if (choice) lastSubs = choice
  if (save) remember(PREF.subtitles, !choice ? 'off' : option?.language || 'any')
  renderSubtitlesMenu()
  loadSubtitles().catch(console.error)
}

/** C: subtitles off, or back on with the last track used (the first text track if none was). */
function toggleSubtitles (): void {
  if (subsChoice) return setSubtitles('')
  const choice = lastSubs || subOptions.find(o => !o.disabled)?.value
  if (choice) setSubtitles(choice)
}

// Chrome menus open upward and stay inside the stage, so they work in fullscreen too
const chromeMenu = (label: string | Node, items: Child[], ariaLabel: string, className = ''): HTMLDetailsElement => menu(label, items, { title: ariaLabel, ariaLabel, up: true, within: () => stage, className })

/** Tags a menu choice with the value it selects, for tests and debugging. */
const withValue = <E extends HTMLElement>(item: E, value: string | number): E => { item.dataset.value = String(value); return item }

function renderSubtitlesMenu (): void {
  const current = subOptions.find(o => o.value === subsChoice)
  const name = `Subtitles: ${current ? current.name : 'Off'}`
  const box = $<HTMLDetailsElement>('#subs-slot details') ?? (fill($('#subs-slot'), chromeMenu(icon('subtitles'), [], name)), $<HTMLDetailsElement>('#subs-slot details'))
  const summary = $('summary', box)
  summary.setAttribute('aria-label', name)
  summary.title = `${name} (C)`
  summary.classList.toggle('on', !!current)
  fill($('.menu-items', box), menuHeading('Subtitles'), withValue(menuChoice('Off', !subsChoice, () => setSubtitles('')), ''),
    ...subOptions.map(o => withValue(menuChoice(o.label, o.value === subsChoice, () => setSubtitles(o.value), { disabled: o.disabled, title: o.disabled ? 'Image subtitles are not supported' : '' }), o.value)))
  $('#subs-slot').hidden = subOptions.length === 0
}

function renderAudioMenu (): void {
  const tracks = info?.audio ?? []
  const selected = tracks[audio]
  const name = `Audio: ${selected ? audioTrackName(selected) : 'Track 1'}`
  fill($('#audio-slot'), chromeMenu(icon('audio'), [
    menuHeading('Audio'),
    ...tracks.map(a => withValue(menuChoice(audioTrackLabel(a), a.index === audio, () => setAudio(a.index)), a.index)),
  ], name))
  $('#audio-slot').hidden = tracks.length < 2
}

/** Switching audio restarts the session at the current position with the other track. */
function setAudio (index: number): void {
  if (index === audio) return
  audio = index
  remember(PREF.audio, info?.audio[index]?.language ?? null)
  renderAudioMenu()
  start(position(), 'Switching audio…').catch(console.error)
}

const speedChoices = (): HTMLButtonElement[] => SPEEDS.map(rate => menuChoice(rate === 1 ? '1× (normal)' : speedLabel(rate), video.playbackRate === rate, () => setSpeed(rate)))

function setSpeed (rate: number, save = true): void {
  video.defaultPlaybackRate = video.playbackRate = rate // the default survives loading a new session
  if (save) remember(PREF.speed, rate)
  renderSpeedMenu()
  renderMore()
  slowSamples = 0
  renderPlaybackStatus()
}

/** < and >: one step slower or faster. */
function stepSpeed (direction: -1 | 1): void {
  const nextRate = steppedSpeed(video.playbackRate, direction)
  setSpeed(nextRate)
  notify(`Speed ${speedLabel(nextRate)}`)
  setTimeout(() => { if ($('#overlay .toast.notice')?.textContent?.startsWith('Speed')) notify('') }, 1200)
}

function renderSpeedMenu (): void {
  const name = `Speed: ${speedLabel(video.playbackRate)}`
  fill($('#speed-slot'), chromeMenu(el('span', { className: 'pill', textContent: speedLabel(video.playbackRate) }), [menuHeading('Speed'), ...speedChoices()], name))
}

/** More: the same file actions as the torrent page's ⋯ menu, Picture in picture, the key list, and Speed on narrow screens. */
function renderMore (): void {
  const pip = document.pictureInPictureEnabled && !video.disablePictureInPicture
  const narrow = <E extends HTMLElement>(item: E): E => { item.classList.add('narrow-only'); return item }
  const items: Child[] = [
    ...(file
      ? [
          menuHeading('Open in'),
          ...playerApps(ih, idx, file.name).map(([text, href, title = '']) => el('a', { href, title, textContent: text })),
          menuSeparator(),
          el('a', { href: urls.download(ih, idx, file.name), textContent: 'Download file' }),
          copyButton('Copy stream link', streamUrl(ih, idx, file.name), 'Copy the stream link for any player'),
          menuSeparator(),
        ]
      : []),
    pip && el('button', { type: 'button', textContent: document.pictureInPictureElement ? 'Exit picture in picture' : 'Picture in picture', onclick: togglePip }),
    el('button', { type: 'button', textContent: 'Keyboard shortcuts', onclick: () => showKeys(true) }),
    menuChoice('Playback flow', flowPinned, toggleFlowPin),
    narrow(menuSeparator()),
    narrow(menuHeading('Speed')),
    ...speedChoices().map(narrow),
  ]
  const box = $<HTMLDetailsElement>('#more-slot details')
  if (box) fill($('.menu-items', box), ...items)
  else fill($('#more-slot'), chromeMenu(icon('more'), items, 'More'))
}

function togglePip (): void {
  const action = document.pictureInPictureElement ? document.exitPictureInPicture() : video.requestPictureInPicture()
  action.catch((err: unknown) => notify(`Picture in picture: ${err instanceof Error ? err.message : String(err)}`, 'warn'))
}

function retryInfo (): void {
  playbackProblem = null
  waitingAt = Date.now()
  setPlaybackPhase('loading')
  loadInfo().catch(console.error)
}

async function loadInfo (signal = pageLife.signal): Promise<void> {
  let probe: ProbeResult
  try {
    probe = await api<ProbeResult>(`/api/probe/${ih}/${idx}`, { signal })
    if (signal.aborted) return
    info = probe
  } catch (error) {
    if (signal.aborted) return
    const err = error as Failure
    if (err.status === 404) return missingFile(err)
    return failPlayback('Could not read the file', err.message, ['retry', 'external'])
  }
  setAspect()
  // The remembered audio language picks the track, else track 1
  audio = pickByLanguage(probe.audio, recall(PREF.audio) as string | null)?.index ?? 0
  renderAudioMenu()
  subOptions = subtitleOptions(probe)
  // The remembered subtitle language turns subtitles on for this file when it has that language
  subsChoice = lastSubs = preferredSubtitle(subOptions, recall(PREF.subtitles))
  renderSubtitlesMenu()
  const saved = resumePosition(recall(progressKey(ih, idx)), probe.duration)
  pendingPosition = saved
  updateTimeline()
  if (saved) {
    notify(`Resume from ${clock(saved)}?`, 'error', [
      button('Resume', () => { start(saved).catch(console.error) }, true),
      button('Start over', () => { remember(progressKey(ih, idx), progressEntry(0, probe.duration)); start(0).catch(console.error) }),
    ])
  } else start(0).catch(console.error)
}

/** Every 2 s: keeps the ffmpeg session alive, updates the seek bar and details, and warns when ffmpeg can't keep up. */
async function pollStatus (signal = pageLife.signal): Promise<void> {
  while (!signal.aborted) {
    const session = cur?.session
    const q = new URLSearchParams({ idx: String(idx), session: session ?? '', pos: String(video.currentTime) })
    const gen = generation
    const st = await api<TorrentStatus>(`/api/torrents/${ih}/status?${q}`, { signal }).catch(() => null)
    if (signal.aborted) return
    if (gen === generation && cur?.session === session && st) {
      lastStatus = st
      statusAt = Date.now()
      if (st.loaded) sourceSnapshot = { status: { ...st, session: null, preparation: null }, at: statusAt }
      const s = st.session
      slowSamples = st.loaded && st.file?.progress === 1 && s?.running && !s.paused && s.speed != null && s.speed < video.playbackRate ? slowSamples + 1 : 0
      if (s && cur) cur.complete = !s.running
      if (st.loaded && cur) {
        record(history, {
          download: st.downloadSpeed,
          peers: st.peers.length,
          speed: s?.speed ?? null,
          fps: s?.fps ?? null,
          cpu: s?.cpu ?? null,
          paused: !!s?.paused,
          ahead: s ? Math.max(0, s.produced - video.currentTime) : null,
          buffer: bufferedAhead(),
          stalled: stalled || stallSeen,
        })
        stallSeen = false
      }
      if (!$('#details').hidden) renderFacts()
      if (!$('#performance').hidden) renderPerformance()
      drawSeekbar()
    } else if (!st) slowSamples = 0
    renderPlaybackStatus()
    try { await sleep(2000, signal) } catch { return }
  }
}

// The chrome ---------------------------------------------------------------

const seek = $<HTMLInputElement>('#seek')
let dragging = false
let autoMuted = false // muted by the autoplay fallback, not by choice

/** The four seek bar layers: on the server, converted by ffmpeg, in the browser, played. */
function drawSeekbar (): void {
  const total = duration()
  const layer = (id: string, value: string): void => { $(id).style.backgroundImage = value }
  if (!total) {
    for (const id of ['#layer-server', '#layer-conv', '#layer-buf']) layer(id, 'none')
    $('#layer-played').style.width = '0'
    return
  }
  const offset = cur?.offset ?? 0
  const session = cur?.session && lastStatus?.session?.id === cur.session ? lastStatus.session : null
  layer('#layer-server', layerBackground(fileRanges() ?? [], 'var(--seek-server)'))
  layer('#layer-conv', layerBackground(session ? [[offset / total, (offset + session.produced) / total]] : [], 'var(--seek-conv)'))
  layer('#layer-buf', layerBackground(cur ? spans(video.buffered).map(([a, b]) => [(a + offset) / total, (b + offset) / total]) : [], 'var(--seek-buf)'))
  $('#layer-played').style.width = `${Math.min(100, (dragging ? Number(seek.value) : position()) / total * 100)}%`
}

/** Time, slider range and its spoken value; while dragging the slider shows where it will land. */
function updateTimeline (): void {
  const total = duration()
  const at = dragging ? Number(seek.value) : position()
  seek.max = String(Math.floor(total))
  if (!dragging) seek.value = String(at)
  seek.setAttribute('aria-valuetext', `${clock(at)} of ${clock(total)}`)
  $('#time').textContent = `${clock(at)} / ${clock(total)}`
  drawSeekbar()
}

/** The tooltip over the seek bar: the time under the pointer and what jumping there will do. */
function showTip (t: number, x: number): void {
  const tip = $('#seektip')
  const total = duration()
  if (!total) return
  const outcome = cur
    ? seekOutcome(t, { mode: cur.mode, offset: cur.offset, duration: total, buffered: spans(video.buffered), seekable: spans(video.seekable), ranges: fileRanges() })
    : 'seekable'
  $('b', tip).textContent = clock(t)
  $('span', tip).textContent = seekHint(outcome)
  tip.hidden = false
  // Keep the tooltip inside the seek bar
  const bar = $('#seekbar').getBoundingClientRect()
  const half = tip.offsetWidth / 2
  tip.style.left = `${Math.max(half, Math.min(bar.width - half, x))}px`
}
const hideTip = (): void => { $('#seektip').hidden = true }

/** Seek bar x (in px from its left edge) for time `t`, matching the inset track. */
function trackPosition (t: number): number {
  const track = $('#seekbar .track')
  return track.offsetLeft + (duration() ? t / duration() : 0) * track.offsetWidth
}

$('#seekbar').addEventListener('pointermove', e => {
  if (dragging) return
  const track = $('#seekbar .track').getBoundingClientRect()
  const fraction = Math.max(0, Math.min(1, (e.clientX - track.left) / track.width))
  showTip(fraction * duration(), e.clientX - $('#seekbar').getBoundingClientRect().left)
})
$('#seekbar').addEventListener('pointerleave', () => { if (!dragging) hideTip() })
seek.addEventListener('input', () => {
  dragging = true
  updateTimeline()
  showTip(Number(seek.value), trackPosition(Number(seek.value)))
})
seek.addEventListener('change', () => {
  dragging = false
  hideTip()
  seekTo(Number(seek.value))
})

// Visibility: shown while paused, while a menu is open, while focus is inside it, and for 2.5 s after the last pointer move, touch or key
let idleTimer = 0
function wake (): void {
  stage.classList.remove('idle')
  clearTimeout(idleTimer)
  idleTimer = setTimeout(sleepChrome, 2500)
}
function sleepChrome (): void {
  if (video.paused || !cur || stage.classList.contains('has-playback-wait') || $('#stage details.menu[open]') || !$('#keys').hidden || $('#stage :focus-visible') || dragging) return
  stage.classList.add('idle')
  hideTip()
}
stage.addEventListener('pointermove', e => { if (e.pointerType !== 'touch') wake() })
stage.addEventListener('pointerleave', e => { if (e.pointerType !== 'touch') { clearTimeout(idleTimer); sleepChrome() } })
stage.addEventListener('toggle', wake, true)
stage.addEventListener('focusin', wake)

/** Before a session has loaded any media there is nothing to play or pause. */
const nothingToPlay = (): boolean => ['loading', 'starting', 'playlist', 'error', 'idle'].includes(playbackPhase) && video.readyState === 0

const togglePlay = (): void => {
  if (nothingToPlay()) return
  if (video.paused) {
    if (playbackPhase === 'paused' || playbackPhase === 'blocked') setPlaybackPhase('buffering')
    video.play().catch((err: unknown) => {
      if (pageLife.signal.aborted) return
      if (err instanceof Error && err.name === 'NotAllowedError') setPlaybackPhase('blocked')
      else failPlayback('Playback could not start', err instanceof Error ? err.message : String(err))
    })
  } else video.pause()
}
// A tap on faded chrome shows it first; with the chrome showing, a tap or click plays or pauses
let tapWoke = false
video.addEventListener('pointerdown', e => {
  // While faded, a touch anywhere, or a click where the controls were, only brings the chrome back
  tapWoke = stage.classList.contains('idle') && (e.pointerType === 'touch' || e.clientY >= $('#chrome').getBoundingClientRect().top)
  wake()
})
video.addEventListener('click', () => {
  if (tapWoke) return
  if ($('#stage details.menu[open]')) return // the click only closes the menu
  if (autoMuted && video.muted) { video.muted = false; autoMuted = false; return }
  togglePlay()
})
video.addEventListener('dblclick', toggleFullscreen)

function renderPlayButton (): void {
  const label = video.paused ? 'Play' : 'Pause'
  const b = $<HTMLButtonElement>('#playpause')
  fill(b, icon(video.paused ? 'play' : 'pause'))
  b.setAttribute('aria-label', label)
  b.title = `${label} (K)`
  b.disabled = nothingToPlay()
}
$('#playpause').addEventListener('click', togglePlay)
$('#back10').addEventListener('click', () => seekTo(position() - 10))
$('#fwd10').addEventListener('click', () => seekTo(position() + 10))
fill($('#back10'), icon('back'))
fill($('#fwd10'), icon('forward'))
fill($('#keys-close'), icon('close'))

/** Volume and mute are saved only when the viewer changes them, not by the autoplay fallback. */
function setVolume (value: number): void {
  video.volume = Math.max(0, Math.min(1, Math.round(value * 100) / 100))
  video.muted = video.volume === 0
  autoMuted = false
  remember(PREF.volume, video.volume)
  remember(PREF.muted, video.muted)
}
function toggleMute (): void {
  if (video.muted && video.volume === 0) video.volume = 0.5
  video.muted = !video.muted
  autoMuted = false
  remember(PREF.muted, video.muted)
  remember(PREF.volume, video.volume)
}
function renderVolume (): void {
  const silent = video.muted || video.volume === 0
  const label = silent ? 'Unmute' : 'Mute'
  const b = $('#mute')
  fill(b, icon(silent ? 'muted' : video.volume < 0.5 ? 'volumeLow' : 'volume'))
  b.setAttribute('aria-label', label)
  b.title = `${label} (M)`
  const slider = $<HTMLInputElement>('#volume')
  slider.value = String(silent ? 0 : video.volume)
  slider.style.setProperty('--vol', `${silent ? 0 : video.volume * 100}%`)
  slider.setAttribute('aria-valuetext', `${Math.round((silent ? 0 : video.volume) * 100)}%`)
}
$('#mute').addEventListener('click', toggleMute)
$<HTMLInputElement>('#volume').addEventListener('input', e => setVolume(Number((e.target as HTMLInputElement).value)))

function toggleFullscreen (): void {
  if (document.fullscreenElement) document.exitFullscreen().catch(console.error)
  else if (stage.requestFullscreen) stage.requestFullscreen().catch(() => {})
  else (video as HTMLVideoElement & { webkitEnterFullscreen?: () => void }).webkitEnterFullscreen?.() // iPhone: only the video element can go fullscreen
}
function renderFullscreen (): void {
  const on = !!document.fullscreenElement
  const label = on ? 'Exit fullscreen' : 'Fullscreen'
  const b = $('#fullscreen')
  fill(b, icon(on ? 'exitFullscreen' : 'fullscreen'))
  b.setAttribute('aria-label', label)
  b.title = `${label} (F)`
}
$('#fullscreen').addEventListener('click', toggleFullscreen)
document.addEventListener('fullscreenchange', () => { renderFullscreen(); wake() })

/** The ? sheet over the video. */
function showKeys (open = $('#keys').hidden): void {
  $('#keys').hidden = !open
  if (open) $('#keys-close').focus()
  wake()
}
$('#keys-close').addEventListener('click', () => showKeys(false))

function playNext (): void {
  if (next) location.href = urls.player(ih, next.idx)
}

function setMediaSession (t: TorrentInfo, f: TorrentFileInfo): void {
  if (!('mediaSession' in navigator)) return
  const ep = episodeLabel(f)
  navigator.mediaSession.metadata = new MediaMetadata({ title: ep ? `${ep} · ${baseName(f.name)}` : baseName(f.name), artist: ep, album: t.name })
  try { navigator.mediaSession.setActionHandler('nexttrack', next ? playNext : null) } catch {}
}
if ('mediaSession' in navigator) {
  const handlers: Partial<Record<MediaSessionAction, MediaSessionActionHandler>> = {
    play: () => { video.play().catch(console.error) },
    pause: () => video.pause(),
    seekbackward: d => seekTo(position() - (d.seekOffset || 10)),
    seekforward: d => seekTo(position() + (d.seekOffset || 10)),
  }
  for (const [action, handler] of Object.entries(handlers)) {
    try { navigator.mediaSession.setActionHandler(action as MediaSessionAction, handler) } catch {} // older browsers lack some actions
  }
}

const commands: Record<PlayerCommand, () => void> = {
  playPause: togglePlay,
  back: () => seekTo(position() - 10),
  forward: () => seekTo(position() + 10),
  volumeUp: () => setVolume((video.muted ? 0 : video.volume) + 0.1),
  volumeDown: () => setVolume((video.muted ? 0 : video.volume) - 0.1),
  mute: toggleMute,
  fullscreen: toggleFullscreen,
  subtitles: toggleSubtitles,
  next: playNext,
  slower: () => stepSpeed(-1),
  faster: () => stepSpeed(1),
}

// Keys. Ignored while typing; Space and Enter keep their usual meaning on buttons and links.
document.addEventListener('keydown', e => {
  if (e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return
  const target = e.target as HTMLElement
  if (target.matches('input:not([type="range"]), select, textarea, [contenteditable]')) return
  if (target === $('#volume') && /^Arrow/.test(e.key)) return
  if ((e.key === ' ' || e.key === 'Enter') && target.closest('button, summary, a')) return
  wake()
  if (e.key === '?') { showKeys(); return }
  if (e.key === 'Escape' && !$('#keys').hidden) { showKeys(false); return }
  if (!cur) return
  const command = keyCommand(e.key)
  if (!command) return
  e.preventDefault() // no page scroll, and the seek slider doesn't also move by one step
  commands[command]()
})

// Player events
video.addEventListener('timeupdate', () => {
  persistProgress()
  if (cur) updateTimeline()
})
video.addEventListener('progress', drawSeekbar)
video.addEventListener('durationchange', updateTimeline)
video.addEventListener('play', () => { renderPlayButton(); wake() })
video.addEventListener('pause', () => {
  renderPlayButton(); wake(); persistProgress(true)
  if (video.readyState >= 2 && !video.ended && ['playing', 'buffering'].includes(playbackPhase)) {
    stalled = false
    setPlaybackPhase('paused')
  }
})
video.addEventListener('seeked', () => { persistProgress(true); renderPlaybackStatus() })
video.addEventListener('ratechange', () => { slowSamples = 0; renderPlaybackStatus() })
video.addEventListener('waiting', () => {
  if (!cur || ['paused', 'error', 'idle'].includes(playbackPhase)) return
  stalled = stallSeen = true
  setPlaybackPhase('buffering')
})
video.addEventListener('playing', () => {
  if (pageLife.signal.aborted || playbackPhase === 'error') return
  starting = ''
  stalled = false
  persistProgress(true)
  playbackProblem = null
  setPlaybackPhase('playing')
  // For "Continue" on the torrent page and the home page
  if (file) remember(`last:${ih}`, { idx, label: fileLabel(file), at: Date.now() })
})
video.addEventListener('error', () => { if (cur?.mode === 'direct') failPlayback('Playback stopped', video.error?.message || `Media error ${video.error?.code}`) })
video.addEventListener('ended', () => { persistProgress(true, true); setPlaybackPhase('idle'); countdownToNext() })
video.addEventListener('volumechange', () => {
  renderVolume()
  if (!video.muted && $('#overlay .toast.notice')) notify('')
})
video.addEventListener('enterpictureinpicture', renderMore)
video.addEventListener('leavepictureinpicture', renderMore)
/** ⓘ Details and other disclosures under the title row: a button that shows and hides its panel. */
function disclosure (toggle: HTMLElement, panel: HTMLElement, onOpen: () => void): void {
  toggle.addEventListener('click', () => {
    panel.hidden = !panel.hidden
    toggle.setAttribute('aria-expanded', String(!panel.hidden))
    if (!panel.hidden) onOpen()
  })
}
disclosure($('#details-toggle'), $('#details'), renderFacts)
disclosure($('#perf-toggle'), $('#performance'), renderPerformance)

/** Redrawn on each poll, only while the disclosure is open. */
function renderPerformance (): void {
  fill($('#performance'), ...performanceView(history, { direct: cur?.mode === 'direct' }))
}

// Theater layout: the stage takes the largest box that fits the band's width and the viewport height
// left by the top bar and the title row (see #stage in style.css). Phones in landscape give the video
// the whole height under the top bar; the title row is one scroll away.
const landscapePhone = matchMedia('(orientation: landscape) and (max-height: 500px)')
function fitStage (): void {
  const root = document.documentElement.style
  root.setProperty('--topbar-h', `${$('.topbar').offsetHeight}px`)
  root.setProperty('--title-row-h', landscapePhone.matches ? '0px' : `${$('#titlerow').offsetHeight}px`)
}
// The top bar's status button changes width as checks come in, which can wrap the bar on a phone
const rowObserver = new ResizeObserver(fitStage)
rowObserver.observe($('#titlerow'))
rowObserver.observe($('.topbar'))
addEventListener('resize', fitStage)
fitStage()

/** The video's display aspect ratio from the probe, corrected for non-square pixels. */
function setAspect (): void {
  const v = info?.video
  if (v?.width && v.height) stage.style.setProperty('--ar', String(v.width * (v.sampleAspect || 1) / v.height))
}

let resumeAt = 0
addEventListener('pagehide', () => {
  if (pageLife.signal.aborted) return
  persistProgress(true)
  resumeAt = position()
  generation++
  pageLife.abort()
  teardown()
  navigator.sendBeacon(`/api/play/tab/${tab}`)
  cur = null
})
addEventListener('pageshow', e => {
  if (!e.persisted) return
  tab = Math.random().toString(36).slice(2)
  pageLife = new AbortController()
  if (info) start(resumeAt).catch(console.error)
  else loadInfo().catch(console.error)
  if (!file) loadTitle().catch(console.error)
  pollStatus().catch(console.error)
  tickPlaybackStatus().catch(console.error)
})

// Remembered volume, mute and speed; native controls stay off in every mode
video.controls = false
const savedVolume = recall(PREF.volume)
if (typeof savedVolume === 'number' && savedVolume >= 0 && savedVolume <= 1) video.volume = savedVolume
video.muted = recall(PREF.muted) === true
setSpeed(savedSpeed(recall(PREF.speed)), false)
renderPlayButton()
renderVolume()
renderFullscreen()
renderSubtitlesMenu()
renderAudioMenu()

if (!/^[a-f0-9]{40}$/.test(ih) || !Number.isInteger(idx) || idx < 0) notify('This player link is incomplete. Open the file from its torrent page.', 'error', [linkButton('Search', '/')])
else {
  renderPlaybackStatus()
  tickPlaybackStatus().catch(console.error)
  loadTitle().catch(console.error)
  loadInfo().catch(console.error)
  pollStatus().catch(console.error)
}
