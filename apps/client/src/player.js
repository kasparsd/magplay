import Hls from 'hls.js'
// The player page, /play/<infohash>/<file index>. One chrome over the video for every playback mode:
// direct files play from /raw, remux and transcode through an HLS session whose timeline starts at cur.offset.
import { api } from './lib/api.ts'
import { measureCaps } from './lib/capabilities.js'
import { icon } from './lib/icons.ts'
import { audioFormat, containerLabel, languageFromName, languageName, pickByLanguage, releaseName } from './lib/naming.ts'
import { performanceView, record } from './lib/performance.ts'
import { parseVtt } from './lib/subtitles.ts'
import { progressKey, progressEntry, resumePosition } from './lib/progress.ts'
import { canSeekLocally, layerBackground, seekHint, seekOutcome, spans } from './lib/seek.ts'
import { $, copyButton, el, episodeLabel, fill, formatBytes, formatClock as clock, formatSpeed, menu, menuChoice, menuHeading, menuSeparator, recall, remember } from './lib/ui.ts'
import { baseName, playerApps, streamUrl, urls } from './lib/urls.ts'

import { serialLatest, delay as sleep } from './lib/requests.ts'
import { explainPlayback } from './lib/playback-status.ts'
import { playbackStatusView } from './lib/playback-status-view.ts'

const requestPlayback = serialLatest()
const video = $('#video')
const stage = $('#stage')
const [, , ih, idxPart] = location.pathname.split('/')
const idx = Number(idxPart)
let tab = Math.random().toString(36).slice(2) // new id for each document activation
let pageLife = new AbortController()
let playLife = null
let subtitleLife = null
let cancelNext = () => {}
let lastProgressSave = 0

/** @type {import('@magplay/api-contract').ProbeResult | null} */
let info = null
/** @type {(import('@magplay/api-contract').PlaybackDecision & {complete?: boolean}) | null} */
let cur = null
let hls = null
let audio = 0
let generation = 0 // bumped on every (re)start so stale async work stops
let pendingPosition = 0 // keep the intended position while a replacement request is in flight
let starting = '' // what the busy spinner says until playback resumes ("Starting at 14:20…")
let searchTitle = ''
let file = null // this file's entry from the torrent's file list
let next = null // the next video in the torrent, if any
/** @type {import('@magplay/api-contract').TorrentStatus | null} */
let lastStatus = null // the latest /status poll, for the details panel and the seek bar
const history = [] // the last 3 minutes of status polls, for the Performance lanes
let stalled = false // waiting for data right now
let stallSeen = false // waited at some point since the last sample
/** @type {import('./lib/playback-status.ts').PlaybackPhase} */
let playbackPhase = 'loading'
/** @type {import('./lib/playback-status.ts').PlaybackProblem | null} */
let playbackProblem = null
let waitingAt = Date.now()
let statusAt = 0
let slowSamples = 0
const subTrack = video.addTextTrack('subtitles', 'Subtitles')
const showPlaybackStatus = playbackStatusView($('#playback-status'), $('#playback-announcement'), name => {
  if (name === 'retry') return button('Try again', () => info ? start(position()) : retryInfo(), true)
  if (name === 'play') return button('Play', togglePlay, true)
  if (name === 'release') return linkButton('Choose another release', urls.search(searchTitle))
  if (!file) return null
  return menu('Open in player', [
    ...playerApps(ih, idx, file.name).map(([text, href]) => el('a', { textContent: text, href })),
    copyButton('Copy stream link', streamUrl(ih, idx, file.name)),
  ], { className: 'button playback-external' })
})

function setPlaybackPhase (phase) {
  if (!['playing', 'paused', 'idle', 'error'].includes(phase) && ['playing', 'paused', 'idle', 'error'].includes(playbackPhase)) waitingAt = Date.now()
  playbackPhase = phase
  renderPlaybackStatus()
}

function failPlayback (title, description, actions = ['retry', 'external']) {
  playbackProblem = { title, description, actions }
  setPlaybackPhase('error')
}

function renderPlaybackStatus () {
  if (pageLife.signal.aborted) return
  const now = Date.now()
  const model = explainPlayback({
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
  })
  if (model && !file) model.actions = model.actions.filter(name => name !== 'external' && name !== 'release')
  showPlaybackStatus(model, now - waitingAt, starting ? `${starting} · Waiting ${Math.floor((now - waitingAt) / 1000)} s` : '')
  renderPlayButton()
  stage.classList.toggle('has-playback-wait', !!model && model.kind !== 'warning' && model.key !== 'brief')
  if (model && model.kind !== 'warning') stage.classList.remove('idle')
}

async function tickPlaybackStatus (signal = pageLife.signal) {
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
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2]

/**
 * Messages on the video itself: 'busy' (spinner in the middle), 'notice' and 'warn' (chips, with optional
 * link buttons), or a centred card with actions for errors and questions. An empty text clears it.
 */
function notify (text, kind = 'notice', actions = []) {
  const overlay = $('#overlay')
  if (!text) return fill(overlay)
  if (kind === 'error') {
    setPlaybackPhase('idle') // resume/countdown prompts own the stage until answered
    return fill(overlay, el('div', { className: 'card' }, el('p', { textContent: text }), actions.length > 0 && el('p', { className: 'actions' }, ...actions)))
  }
  fill(overlay, el('div', { className: `toast ${kind}` }, text, ...actions))
}

const button = (label, onclick, primary) => el('button', { type: 'button', className: `button${primary ? ' primary' : ''}`, textContent: label, onclick })
const linkButton = (label, href, primary) => el('a', { className: `button${primary ? ' primary' : ''}`, href, textContent: label })

/** A file number this torrent doesn't have: retrying can't help, so offer only the way back and hide the empty controls. */
function missingFile (err) {
  for (const sel of ['#title-actions', '#details', '#performance', '#chrome']) $(sel).hidden = true
  return notify(err.message, 'error', [linkButton('Back to files', urls.torrent(ih), true)])
}

const fileLabel = f => episodeLabel(f) || baseName(f.name)

/** Names the page after the file, links back to its torrent, offers external players and finds the next episode. */
async function loadTitle (signal = pageLife.signal) {
  $('#back').href = urls.torrent(ih)
  const t = await api(`/api/torrents/${ih}`, { signal }).catch(() => null)
  if (signal.aborted) return
  file = t?.files.find(x => x.idx === idx)
  if (t) { $('#back').textContent = `← ${t.name}`; searchTitle = releaseName(t.name) }
  if (!file) return
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
    const link = $('#next')
    Object.assign(link, { href: urls.player(ih, next.idx), title: `${name} (N)`, hidden: false })
    link.setAttribute('aria-label', name)
    fill(link, el('span', { className: 'pill wide-only', textContent: name }), el('span', { className: 'narrow-only' }, icon('next')))
  }
  renderMore()
  setMediaSession(t)
  renderFacts()
  renderPlaybackStatus()
}

/** At the end of a video: play the next one after 10 s unless cancelled. */
function countdownToNext () {
  cancelNext()
  if (!next || pageLife.signal.aborted) return
  const target = urls.player(ih, next.idx)
  let left = 10
  const timer = setInterval(() => {
    if (--left <= 0) { cancel(); location.href = target } else render()
  }, 1000)
  const cancel = () => {
    clearInterval(timer)
    video.removeEventListener('play', cancel)
    cancelNext = () => {}
    notify('')
  }
  cancelNext = cancel
  const render = () => notify(`Next: ${fileLabel(next)} in ${left} s`, 'error',
    [linkButton('Play now', target, true), button('Cancel', cancel)])
  render()
  video.addEventListener('play', cancel, { once: true })
}

/** The ⓘ panel: how this file is being played, and how the torrent is doing. */
function renderFacts () {
  const v = info?.video
  const a = info?.audio[audio]
  const st = lastStatus
  const s = st?.session
  const rows = [
    ['Mode', cur ? `${cur.mode}: ${cur.reason}` : null],
    ['File', file ? `${baseName(file.name)} (${formatBytes(file.size)})` : null],
    ['Container', containerLabel(info?.container, file?.name)],
    ['Video', v && `${v.codec}${v.profile ? ` ${v.profile}` : ''}, ${v.width}×${v.height}, ${(v.width * (v.sampleAspect || 1) / v.height).toFixed(2)}:1, ${v.bitDepth}-bit`],
    ['Audio', a && [audioFormat(a.codec, a.channels), languageName(a.language)].filter(Boolean).join(', ')],
    ['Peers', st?.loaded ? `${st.peers.length} · ↓ ${formatSpeed(st.downloadSpeed)}` : null],
    ['On the server', st?.file ? `${Math.round(st.file.progress * 100)}% of this file` : null],
    ['Buffered', cur ? `${Math.max(0, Math.round(bufferedAhead()))} s ahead` : null],
    ['ffmpeg', s ? `${s.speed ? `${s.speed.toFixed(1)}x` : '…'}${s.paused ? ', paused far enough ahead' : s.running ? '' : ', finished'}` : null],
  ].filter(([, value]) => value)
  fill($('#facts'), ...rows.flatMap(([k, value]) => [el('dt', { textContent: k }), el('dd', { textContent: value })]))
}

const caps = measureCaps(video, window)

const position = () => cur ? cur.offset + video.currentTime : pendingPosition
/** The whole file's duration: HLS sessions only know their own part, and direct decisions may not know it at all. */
const duration = () => cur?.duration || info?.duration || (cur?.mode === 'direct' && Number.isFinite(video.duration) ? video.duration : 0)
/** Seconds the browser has buffered past the playhead. */
function bufferedAhead () {
  const now = video.currentTime
  const range = spans(video.buffered).find(([a, b]) => now >= a - 0.5 && now <= b)
  return range ? range[1] - now : 0
}

function persistProgress (force = false, ended = false) {
  if (!cur || video.readyState < 2) return
  const now = Date.now()
  if (!force && now - lastProgressSave < 5000) return
  // A growing HLS playlist's local duration is not the whole file duration.
  const total = cur.duration ?? (cur.mode === 'direct' ? video.duration : null)
  const record = progressEntry(position(), total, { ended, at: now })
  if (record) {
    remember(progressKey(ih, idx), record)
    lastProgressSave = now
  }
}

function teardown () {
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
async function start (at = 0, message = '') {
  if (pageLife.signal.aborted) return
  const gen = ++generation
  pendingPosition = at
  starting = message
  teardown()
  const signal = (playLife = new AbortController()).signal
  const requestTab = tab
  const pageSignal = pageLife.signal
  const current = () => gen === generation && !signal.aborted
  cur = null
  lastStatus = null
  statusAt = 0
  slowSamples = 0
  playbackProblem = null
  waitingAt = Date.now()
  notify('')
  setPlaybackPhase('starting')
  const selectedAudio = audio
  try {
    const decision = await requestPlayback(async current => {
      if (gen !== generation) return null
      const result = await api('/api/play', { json: { ih, idx, audio: selectedAudio, start: at, caps, tab: requestTab }, signal: pageSignal })
      if (!current() || gen !== generation) {
        if (result.session) navigator.sendBeacon(`/api/play/${result.session}`)
        return null
      }
      return result
    })
    if (gen !== generation || !decision) return
    cur = decision
    lastStatus = null // discard polls from before this session existed
    statusAt = 0
  } catch (err) {
    if (!current()) return
    cur = null
    if (err.status === 404) return missingFile(err)
    return failPlayback(err.status === 422 ? 'This browser cannot play this video' : 'Playback could not start', err.message,
      err.status === 422 ? ['external', 'release'] : ['retry', 'external'])
  }
  if (gen !== generation) return
  updateTimeline()

  if (cur.mode === 'direct') {
    video.src = cur.url
    if (at) video.currentTime = at
  } else {
    setPlaybackPhase('playlist')
    try {
      await waitForPlaylist(cur.url, gen, signal)
    } catch (err) {
      return current() && failPlayback('The stream did not become ready', err.message)
    }
    if (gen !== generation) return
    // Safari plays HLS (and HEVC) natively; other browsers use hls.js
    if (!Hls.isSupported() || (navigator.vendor.includes('Apple') && video.canPlayType('application/vnd.apple.mpegurl'))) {
      video.src = cur.url
    } else {
      hls = new Hls({ startPosition: 0, maxBufferLength: 60 })
      hls.on(Hls.Events.ERROR, (_, data) => current() && data.fatal && failPlayback('Playback stopped', `Playback error: ${data.details}`))
      hls.loadSource(cur.url)
      hls.attachMedia(video)
    }
  }
  renderFacts()
  // Browsers may block autoplay with sound until the page has been clicked; start muted then
  video.play().catch(err => {
    if (!current()) return
    if (err.name !== 'NotAllowedError') return failPlayback('Playback could not start', err.message)
    video.muted = true
    autoMuted = true
    video.play().then(() => current() && notify('Muted: autoplay with sound was blocked. Click the video or press M to unmute.'),
      err => {
        if (!current()) return
        if (err.name === 'NotAllowedError') setPlaybackPhase('blocked')
        else failPlayback('Playback could not start', err.message)
      })
  })
  loadSubtitles(gen)
}

async function waitForPlaylist (url, gen, signal) {
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
function seekTo (t) {
  if (!cur) return
  t = Math.max(0, Math.min(t, (duration() || Infinity) - 1))
  if (cur.mode === 'direct') {
    video.currentTime = t
    return
  }
  const rel = t - cur.offset
  // Only seek locally where the browser can actually land (see canSeekLocally); otherwise restart the session at the target
  if (canSeekLocally(rel, spans(video.seekable))) video.currentTime = rel
  else start(t, `Starting at ${clock(t)}…`)
}

// Subtitles share one text track. Parsing is pure; polling, growing-file
// handling and HLS offset application remain owned by this page.
let subtitleRun = 0
let subsChoice = '' // '' (off), 'embedded:<n>' or 'file:<idx>'
let lastSubs = '' // the last track turned on, for C
let subOptions = [] // { value, label, name, language, disabled }
async function loadSubtitles (gen = generation) {
  subtitleLife?.abort()
  const signal = (subtitleLife = new AbortController()).signal
  const run = ++subtitleRun
  for (const cue of [...(subTrack.cues ?? [])]) subTrack.removeCue(cue)
  const choice = subsChoice
  subTrack.mode = choice ? 'showing' : 'hidden'
  if (!choice || !cur) return
  const [kind, n] = choice.split(':')
  let url
  let shift = 0
  if (kind === 'file') {
    url = `/subs/${ih}/${n}/file.vtt`
    shift = -cur.offset // external files are timed from the start of the video
  } else if (cur.mode === 'direct') {
    url = `/subs/${ih}/${idx}/${n}.vtt`
    notify('Extracting subtitles (needs the whole file downloaded)…', 'busy')
  } else {
    url = cur.subtitles.find(s => s.index === Number(n))?.url
  }
  let added = 0
  // Session subtitles grow as ffmpeg works, so poll until it's done
  for (;;) {
    const res = await fetch(url, { cache: 'no-store', signal }).catch(() => null)
    if (signal.aborted || gen !== generation || run !== subtitleRun || subsChoice !== choice) return
    const growing = url.startsWith('/hls/') && !cur.complete
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
      return notify(`Subtitles failed: ${(await res?.json().catch(() => null))?.error || 'unknown error'}`, 'warn')
    }
    if (!growing) return
    try { await sleep(10_000, signal) } catch { return }
  }
}

/** Turns subtitles on with `choice`, or off with ''. Remembers the language for the next file unless `save` is false. */
function setSubtitles (choice, save = true) {
  subsChoice = choice
  const option = subOptions.find(o => o.value === choice)
  if (choice) lastSubs = choice
  if (save) remember(PREF.subtitles, !choice ? 'off' : option?.language || 'any')
  renderSubtitlesMenu()
  loadSubtitles()
}

/** C: subtitles off, or back on with the last track used (the first text track if none was). */
function toggleSubtitles () {
  if (subsChoice) return setSubtitles('')
  const choice = lastSubs || subOptions.find(o => !o.disabled)?.value
  if (choice) setSubtitles(choice)
}

// Chrome menus open upward and stay inside the stage, so they work in fullscreen too
const chromeMenu = (label, items, ariaLabel, className = '') => menu(label, items, { title: ariaLabel, ariaLabel, up: true, within: () => stage, className })

/** Tags a menu choice with the value it selects, for tests and debugging. */
const withValue = (item, value) => { item.dataset.value = String(value); return item }

function renderSubtitlesMenu () {
  const current = subOptions.find(o => o.value === subsChoice)
  const name = `Subtitles: ${current ? current.name : 'Off'}`
  const box = $('#subs-slot details') ?? (fill($('#subs-slot'), chromeMenu(icon('subtitles'), [], name)), $('#subs-slot details'))
  const summary = $('summary', box)
  summary.setAttribute('aria-label', name)
  summary.title = `${name} (C)`
  summary.classList.toggle('on', !!current)
  fill($('.menu-items', box), menuHeading('Subtitles'), withValue(menuChoice('Off', !subsChoice, () => setSubtitles('')), ''),
    ...subOptions.map(o => withValue(menuChoice(o.label, o.value === subsChoice, () => setSubtitles(o.value), { disabled: o.disabled, title: o.disabled ? 'Image subtitles are not supported' : '' }), o.value)))
  $('#subs-slot').hidden = subOptions.length === 0
}

function renderAudioMenu () {
  const tracks = info?.audio ?? []
  const label = a => [languageName(a.language) || `Track ${a.index + 1}`, a.title].filter(Boolean).join(' · ')
  const name = `Audio: ${tracks[audio] ? label(tracks[audio]) : 'Track 1'}`
  fill($('#audio-slot'), chromeMenu(icon('audio'), [
    menuHeading('Audio'),
    ...tracks.map(a => withValue(menuChoice(`${label(a)} (${audioFormat(a.codec, a.channels)})`, a.index === audio, () => setAudio(a.index)), a.index)),
  ], name))
  $('#audio-slot').hidden = tracks.length < 2
}

/** Switching audio restarts the session at the current position with the other track. */
function setAudio (index) {
  if (index === audio) return
  audio = index
  remember(PREF.audio, info?.audio[index]?.language ?? null)
  renderAudioMenu()
  start(position(), 'Switching audio…')
}

const speedLabel = rate => `${rate}×`
const speedChoices = () => SPEEDS.map(rate => menuChoice(rate === 1 ? '1× (normal)' : speedLabel(rate), video.playbackRate === rate, () => setSpeed(rate)))

function setSpeed (rate, save = true) {
  video.defaultPlaybackRate = video.playbackRate = rate // the default survives loading a new session
  if (save) remember(PREF.speed, rate)
  renderSpeedMenu()
  renderMore()
  slowSamples = 0
  renderPlaybackStatus()
}

/** < and >: one step slower or faster. */
function stepSpeed (direction) {
  const i = SPEEDS.indexOf(video.playbackRate)
  const nextRate = SPEEDS[Math.max(0, Math.min(SPEEDS.length - 1, (i < 0 ? SPEEDS.indexOf(1) : i) + direction))]
  setSpeed(nextRate)
  notify(`Speed ${speedLabel(nextRate)}`)
  setTimeout(() => $('#overlay .toast.notice')?.textContent.startsWith('Speed') && notify(''), 1200)
}

function renderSpeedMenu () {
  const name = `Speed: ${speedLabel(video.playbackRate)}`
  fill($('#speed-slot'), chromeMenu(el('span', { className: 'pill', textContent: speedLabel(video.playbackRate) }), [menuHeading('Speed'), ...speedChoices()], name))
}

/** More: the same file actions as the torrent page's ⋯ menu, Picture in picture, the key list, and Speed on narrow screens. */
function renderMore () {
  const pip = document.pictureInPictureEnabled && !video.disablePictureInPicture
  const narrow = el => { el.classList.add('narrow-only'); return el }
  const items = [
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
    narrow(menuSeparator()),
    narrow(menuHeading('Speed')),
    ...speedChoices().map(narrow),
  ]
  const box = $('#more-slot details')
  if (box) fill($('.menu-items', box), ...items)
  else fill($('#more-slot'), chromeMenu(icon('more'), items, 'More'))
}

function togglePip () {
  const action = document.pictureInPictureElement ? document.exitPictureInPicture() : video.requestPictureInPicture()
  action.catch(err => notify(`Picture in picture: ${err.message}`, 'warn'))
}

function retryInfo () {
  playbackProblem = null
  waitingAt = Date.now()
  setPlaybackPhase('loading')
  loadInfo()
}

async function loadInfo (signal = pageLife.signal) {
  try {
    const result = await api(`/api/probe/${ih}/${idx}`, { signal })
    if (signal.aborted) return
    info = result
  } catch (err) {
    if (signal.aborted) return
    if (err.status === 404) return missingFile(err)
    return failPlayback('Could not read the file', err.message, ['retry', 'external'])
  }
  setAspect()
  // The remembered audio language picks the track, else track 1
  audio = pickByLanguage(info.audio, recall(PREF.audio))?.index ?? 0
  renderAudioMenu()
  const named = t => [languageName(t.language), t.title].filter(Boolean).join(' · ')
  subOptions = [
    ...info.subtitles.map(s => ({
      value: `embedded:${s.index}`,
      name: named(s) || `Track ${s.index + 1}`,
      label: `${named(s) || `Track ${s.index + 1}`}${s.text ? '' : ' (image, not supported)'}`,
      language: s.language,
      disabled: !s.text,
    })),
    ...info.externalSubtitles.map(f => {
      const language = languageFromName(f.name)
      return { value: `file:${f.idx}`, name: languageName(language) || baseName(f.name), label: baseName(f.name), language, disabled: false }
    }),
  ]
  // The remembered subtitle language turns subtitles on for this file when it has that language
  const pref = recall(PREF.subtitles)
  const usable = subOptions.filter(o => !o.disabled)
  const preferred = pref === 'any' ? usable[0] : typeof pref === 'string' && pref !== 'off' ? pickByLanguage(usable, pref) : undefined
  subsChoice = lastSubs = preferred?.value ?? ''
  renderSubtitlesMenu()
  const saved = resumePosition(recall(progressKey(ih, idx)), info.duration)
  pendingPosition = saved
  updateTimeline()
  if (saved) {
    notify(`Resume from ${clock(saved)}?`, 'error', [
      button('Resume', () => start(saved), true),
      button('Start over', () => { remember(progressKey(ih, idx), progressEntry(0, info.duration)); start(0) }),
    ])
  } else start(0)
}

/** Every 2 s: keeps the ffmpeg session alive, updates the seek bar and details, and warns when ffmpeg can't keep up. */
async function pollStatus (signal = pageLife.signal) {
  while (!signal.aborted) {
    const session = cur?.session
    const q = new URLSearchParams({ idx, session: session ?? '', pos: video.currentTime })
    const gen = generation
    const st = await api(`/api/torrents/${ih}/status?${q}`, { signal }).catch(() => null)
    if (signal.aborted) return
    if (gen === generation && cur?.session === session && st) {
      lastStatus = st
      statusAt = Date.now()
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

const seek = $('#seek')
let dragging = false
let autoMuted = false // muted by the autoplay fallback, not by choice

/** The four seek bar layers: on the server, converted by ffmpeg, in the browser, played. */
function drawSeekbar () {
  const total = duration()
  const layer = (id, value) => { $(id).style.backgroundImage = value }
  if (!total) {
    for (const id of ['#layer-server', '#layer-conv', '#layer-buf']) layer(id, 'none')
    $('#layer-played').style.width = '0'
    return
  }
  const offset = cur?.offset ?? 0
  const session = cur?.session && lastStatus?.session?.id === cur.session ? lastStatus.session : null
  layer('#layer-server', layerBackground(lastStatus?.file?.ranges ?? [], 'var(--seek-server)'))
  layer('#layer-conv', layerBackground(session ? [[offset / total, (offset + session.produced) / total]] : [], 'var(--seek-conv)'))
  layer('#layer-buf', layerBackground(cur ? spans(video.buffered).map(([a, b]) => [(a + offset) / total, (b + offset) / total]) : [], 'var(--seek-buf)'))
  $('#layer-played').style.width = `${Math.min(100, (dragging ? Number(seek.value) : position()) / total * 100)}%`
}

/** Time, slider range and its spoken value; while dragging the slider shows where it will land. */
function updateTimeline () {
  const total = duration()
  const at = dragging ? Number(seek.value) : position()
  seek.max = String(Math.floor(total))
  if (!dragging) seek.value = String(at)
  seek.setAttribute('aria-valuetext', `${clock(at)} of ${clock(total)}`)
  $('#time').textContent = `${clock(at)} / ${clock(total)}`
  drawSeekbar()
}

/** The tooltip over the seek bar: the time under the pointer and what jumping there will do. */
function showTip (t, x) {
  const tip = $('#seektip')
  const total = duration()
  if (!total) return
  const outcome = cur
    ? seekOutcome(t, { mode: cur.mode, offset: cur.offset, duration: total, buffered: spans(video.buffered), seekable: spans(video.seekable), ranges: lastStatus?.file?.ranges ?? null })
    : 'seekable'
  $('b', tip).textContent = clock(t)
  $('span', tip).textContent = seekHint(outcome)
  tip.hidden = false
  // Keep the tooltip inside the seek bar
  const bar = $('#seekbar').getBoundingClientRect()
  const half = tip.offsetWidth / 2
  tip.style.left = `${Math.max(half, Math.min(bar.width - half, x))}px`
}
const hideTip = () => { $('#seektip').hidden = true }

/** Seek bar x (in px from its left edge) for time `t`, matching the inset track. */
function trackPosition (t) {
  const track = $('#seekbar .track')
  return track.offsetLeft + (duration() ? t / duration() : 0) * track.offsetWidth
}

$('#seekbar').addEventListener('pointermove', e => {
  if (dragging) return
  const track = $('#seekbar .track').getBoundingClientRect()
  const fraction = Math.max(0, Math.min(1, (e.clientX - track.left) / track.width))
  showTip(fraction * duration(), e.clientX - $('#seekbar').getBoundingClientRect().left)
})
$('#seekbar').addEventListener('pointerleave', () => dragging || hideTip())
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
function wake () {
  stage.classList.remove('idle')
  clearTimeout(idleTimer)
  idleTimer = setTimeout(sleepChrome, 2500)
}
function sleepChrome () {
  if (video.paused || !cur || stage.classList.contains('has-playback-wait') || $('#stage details.menu[open]') || !$('#keys').hidden || $('#stage :focus-visible') || dragging) return
  stage.classList.add('idle')
  hideTip()
}
stage.addEventListener('pointermove', e => { if (e.pointerType !== 'touch') wake() })
stage.addEventListener('pointerleave', e => { if (e.pointerType !== 'touch') { clearTimeout(idleTimer); sleepChrome() } })
stage.addEventListener('toggle', wake, true)
stage.addEventListener('focusin', wake)

const togglePlay = () => {
  if (['loading', 'starting', 'playlist', 'error', 'idle'].includes(playbackPhase) && video.readyState === 0) return
  if (video.paused) {
    if (playbackPhase === 'paused' || playbackPhase === 'blocked') setPlaybackPhase('buffering')
    video.play().catch(err => {
      if (pageLife.signal.aborted) return
      if (err.name === 'NotAllowedError') setPlaybackPhase('blocked')
      else failPlayback('Playback could not start', err.message)
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

function renderPlayButton () {
  const label = video.paused ? 'Play' : 'Pause'
  const b = $('#playpause')
  fill(b, icon(video.paused ? 'play' : 'pause'))
  b.setAttribute('aria-label', label)
  b.title = `${label} (K)`
  b.disabled = ['loading', 'starting', 'playlist', 'error', 'idle'].includes(playbackPhase) && video.readyState === 0
}
$('#playpause').addEventListener('click', togglePlay)
$('#back10').addEventListener('click', () => seekTo(position() - 10))
$('#fwd10').addEventListener('click', () => seekTo(position() + 10))
fill($('#back10'), icon('back'))
fill($('#fwd10'), icon('forward'))
fill($('#keys-close'), icon('close'))

/** Volume and mute are saved only when the viewer changes them, not by the autoplay fallback. */
function setVolume (value) {
  video.volume = Math.max(0, Math.min(1, Math.round(value * 100) / 100))
  video.muted = video.volume === 0
  autoMuted = false
  remember(PREF.volume, video.volume)
  remember(PREF.muted, video.muted)
}
function toggleMute () {
  if (video.muted && video.volume === 0) video.volume = 0.5
  video.muted = !video.muted
  autoMuted = false
  remember(PREF.muted, video.muted)
  remember(PREF.volume, video.volume)
}
function renderVolume () {
  const silent = video.muted || video.volume === 0
  const label = silent ? 'Unmute' : 'Mute'
  const b = $('#mute')
  fill(b, icon(silent ? 'muted' : video.volume < 0.5 ? 'volumeLow' : 'volume'))
  b.setAttribute('aria-label', label)
  b.title = `${label} (M)`
  const slider = $('#volume')
  slider.value = String(silent ? 0 : video.volume)
  slider.style.setProperty('--vol', `${silent ? 0 : video.volume * 100}%`)
  slider.setAttribute('aria-valuetext', `${Math.round((silent ? 0 : video.volume) * 100)}%`)
}
$('#mute').addEventListener('click', toggleMute)
$('#volume').addEventListener('input', e => setVolume(Number(e.target.value)))

function toggleFullscreen () {
  if (document.fullscreenElement) document.exitFullscreen()
  else if (stage.requestFullscreen) stage.requestFullscreen().catch(() => {})
  else video.webkitEnterFullscreen?.() // iPhone: only the video element can go fullscreen
}
function renderFullscreen () {
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
function showKeys (open = $('#keys').hidden) {
  $('#keys').hidden = !open
  if (open) $('#keys-close').focus()
  wake()
}
$('#keys-close').addEventListener('click', () => showKeys(false))

function setMediaSession (t) {
  if (!('mediaSession' in navigator)) return
  const ep = episodeLabel(file)
  navigator.mediaSession.metadata = new MediaMetadata({ title: ep ? `${ep} · ${baseName(file.name)}` : baseName(file.name), artist: ep, album: t.name })
  try { navigator.mediaSession.setActionHandler('nexttrack', next ? () => { location.href = urls.player(ih, next.idx) } : null) } catch {}
}
if ('mediaSession' in navigator) {
  const handlers = {
    play: () => video.play(),
    pause: () => video.pause(),
    seekbackward: d => seekTo(position() - (d.seekOffset || 10)),
    seekforward: d => seekTo(position() + (d.seekOffset || 10)),
  }
  for (const [action, handler] of Object.entries(handlers)) {
    try { navigator.mediaSession.setActionHandler(action, handler) } catch {} // older browsers lack some actions
  }
}

// Keys. Ignored while typing; Space and Enter keep their usual meaning on buttons and links.
document.addEventListener('keydown', e => {
  if (e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return
  const target = e.target
  if (target.matches('input:not([type="range"]), select, textarea, [contenteditable]')) return
  if (target === $('#volume') && /^Arrow/.test(e.key)) return
  if ((e.key === ' ' || e.key === 'Enter') && target.closest('button, summary, a')) return
  wake()
  if (e.key === '?') { showKeys(); return }
  if (e.key === 'Escape' && !$('#keys').hidden) { showKeys(false); return }
  if (!cur) return
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key
  const actions = {
    ' ': togglePlay,
    k: togglePlay,
    ArrowLeft: () => seekTo(position() - 10),
    j: () => seekTo(position() - 10),
    ArrowRight: () => seekTo(position() + 10),
    l: () => seekTo(position() + 10),
    ArrowUp: () => setVolume((video.muted ? 0 : video.volume) + 0.1),
    ArrowDown: () => setVolume((video.muted ? 0 : video.volume) - 0.1),
    m: toggleMute,
    f: toggleFullscreen,
    c: toggleSubtitles,
    n: () => { if (next) location.href = urls.player(ih, next.idx) },
    '<': () => stepSpeed(-1),
    '>': () => stepSpeed(1),
  }
  const action = actions[key]
  if (!action) return
  e.preventDefault() // no page scroll, and the seek slider doesn't also move by one step
  action()
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
video.addEventListener('error', () => cur?.mode === 'direct' && failPlayback('Playback stopped', video.error?.message || `Media error ${video.error?.code}`))
video.addEventListener('ended', () => { persistProgress(true, true); setPlaybackPhase('idle'); countdownToNext() })
video.addEventListener('volumechange', () => {
  renderVolume()
  if (!video.muted && $('#overlay .toast.notice')) notify('')
})
video.addEventListener('enterpictureinpicture', renderMore)
video.addEventListener('leavepictureinpicture', renderMore)
/** ⓘ Details and other disclosures under the title row: a button that shows and hides its panel. */
function disclosure (toggle, panel, onOpen) {
  toggle.addEventListener('click', () => {
    panel.hidden = !panel.hidden
    toggle.setAttribute('aria-expanded', String(!panel.hidden))
    if (!panel.hidden) onOpen()
  })
}
disclosure($('#details-toggle'), $('#details'), renderFacts)
disclosure($('#perf-toggle'), $('#performance'), renderPerformance)

/** Redrawn on each poll, only while the disclosure is open. */
function renderPerformance () {
  fill($('#performance'), ...performanceView(history, { direct: cur?.mode === 'direct' }))
}

// Theater layout: the stage takes the largest box that fits the band's width and the viewport height
// left by the top bar and the title row (see #stage in style.css). Phones in landscape give the video
// the whole height under the top bar; the title row is one scroll away.
const landscapePhone = matchMedia('(orientation: landscape) and (max-height: 500px)')
function fitStage () {
  const root = document.documentElement.style
  root.setProperty('--topbar-h', `${$('.topbar').offsetHeight}px`)
  root.setProperty('--title-row-h', landscapePhone.matches ? '0px' : `${$('#titlerow').offsetHeight}px`)
}
new ResizeObserver(fitStage).observe($('#titlerow'))
addEventListener('resize', fitStage)
fitStage()

/** The video's display aspect ratio from the probe, corrected for non-square pixels. */
function setAspect () {
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
  if (info) start(resumeAt)
  else loadInfo()
  if (!file) loadTitle()
  pollStatus()
  tickPlaybackStatus()
})

// Remembered volume, mute and speed; native controls stay off in every mode
video.controls = false
const savedVolume = recall(PREF.volume)
if (typeof savedVolume === 'number' && savedVolume >= 0 && savedVolume <= 1) video.volume = savedVolume
video.muted = recall(PREF.muted) === true
const savedSpeed = recall(PREF.speed)
setSpeed(SPEEDS.includes(savedSpeed) ? savedSpeed : 1, false)
renderPlayButton()
renderVolume()
renderFullscreen()
renderSubtitlesMenu()
renderAudioMenu()

if (!/^[a-f0-9]{40}$/.test(ih ?? '') || !Number.isInteger(idx) || idx < 0) notify('This player link is incomplete. Open the file from its torrent page.', 'error', [linkButton('Search', '/')])
else {
  renderPlaybackStatus()
  tickPlaybackStatus()
  loadTitle()
  loadInfo()
  pollStatus()
}
