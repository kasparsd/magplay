import Hls from 'hls.js'
// The player page, /play/<infohash>/<file index>.
import { api } from './lib/api.js'
import { measureCaps } from './lib/capabilities.js'
import { parseVtt } from './lib/subtitles.js'
import { progressKey, progressEntry, resumePosition } from './lib/progress.js'
import { $, copyButton, el, episodeLabel, fill, formatBytes, formatClock as clock, formatSpeed, menu, menuHeading, recall, remember } from './lib/ui.js'
import { baseName, playerApps, streamUrl, urls } from './lib/urls.js'

import { serialLatest, delay as sleep } from './lib/requests.js'

const requestPlayback = serialLatest()
const video = $('#video')
const [, , ih, idxPart] = location.pathname.split('/')
const idx = Number(idxPart)
let tab = Math.random().toString(36).slice(2) // new id for each document activation
let pageLife = new AbortController()
let playLife = null
let subtitleLife = null
let cancelNext = () => {}
let lastProgressSave = 0

/** @type {import('./lib/api-types.js').ProbeResult | null} */
let info = null
/** @type {(import('./lib/api-types.js').PlaybackDecision & {complete?: boolean}) | null} */
let cur = null
let hls = null
let audio = 0
let produced = 0 // seconds of output ffmpeg has written for the current session
let generation = 0 // bumped on every (re)start so stale async work stops
let pendingPosition = 0 // keep the intended position while a replacement request is in flight
let file = null // this file's entry from the torrent's file list
let next = null // the next video in the torrent, if any
/** @type {import('./lib/api-types.js').TorrentStatus | null} */
let lastStatus = null // the latest /status poll, for the details panel
const subTrack = video.addTextTrack('subtitles', 'Subtitles')

/**
 * Messages on the video itself: 'busy' (spinner chip), 'notice' and 'warn' (chips), or a card with actions for errors.
 * An empty text clears it.
 */
function notify (text, kind = 'notice', actions = []) {
  const overlay = $('#overlay')
  if (!text) return fill(overlay)
  if (kind === 'error') return fill(overlay, el('div', { className: 'card' }, el('p', { textContent: text }), actions.length > 0 && el('p', { className: 'actions' }, ...actions)))
  fill(overlay, el('div', { className: `toast ${kind}` }, text))
}

const button = (label, onclick, primary) => el('button', { type: 'button', className: `button${primary ? ' primary' : ''}`, textContent: label, onclick })
const linkButton = (label, href, primary) => el('a', { className: `button${primary ? ' primary' : ''}`, href, textContent: label })

/** Actions offered when the browser can't play this file: the first external player, the stream link, back to the files. */
function refusalActions () {
  const [label, href] = file ? playerApps(ih, idx, file.name)[0] : []
  return [
    label && linkButton(label, href, true),
    file && copyButton('Copy stream link', streamUrl(ih, idx, file.name)),
    linkButton('Back to files', urls.torrent(ih)),
  ].filter(Boolean)
}

/** Names the page after the file, links back to its torrent, offers external players and finds the next episode. */
async function loadTitle (signal = pageLife.signal) {
  $('#back').href = urls.torrent(ih)
  const t = await api(`/api/torrents/${ih}`, { signal }).catch(() => null)
  if (signal.aborted) return
  file = t?.files.find(x => x.idx === idx)
  if (!file) return
  const label = episodeLabel(file)
  $('#back').textContent = `← ${t.name}`
  $('#title').textContent = [label, baseName(file.name)].filter(Boolean).join(' · ')
  document.title = `${label || baseName(file.name)} · magplay`
  fill($('#openin'), menu('Open in ▾', [
    menuHeading('Other players'),
    ...playerApps(ih, idx, file.name).map(([text, href, title = '']) => el('a', { href, title, textContent: text })),
    copyButton('Copy stream link', streamUrl(ih, idx, file.name), 'Copy the stream link for any player'),
  ], { className: 'button' }))
  // The file list is sorted by season and episode, so the next video is the next entry
  const videos = t.files.filter(f => f.isVideo)
  next = videos[videos.findIndex(f => f.idx === idx) + 1] ?? null
  if (next) {
    fill($('#next'), el('span', {}, el('span', { className: 'muted', textContent: 'Next ' }), episodeLabel(next) || baseName(next.name)),
      linkButton('Play ›', urls.player(ih, next.idx)))
    $('#next').hidden = false
  }
  renderFacts()
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
  const render = () => notify(`Next: ${episodeLabel(next) || baseName(next.name)} in ${left} s`, 'error',
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
  const ahead = video.buffered.length ? video.buffered.end(video.buffered.length - 1) - video.currentTime : 0
  const rows = [
    ['Mode', cur ? `${cur.mode}: ${cur.reason}` : null],
    ['File', file ? `${baseName(file.name)} (${formatBytes(file.size)})` : null],
    ['Container', info?.container],
    ['Video', v && `${v.codec}${v.profile ? ` ${v.profile}` : ''}, ${v.height}p, ${v.bitDepth}-bit`],
    ['Audio', a && `${a.codec}, ${a.channels} ch${a.language ? `, ${a.language}` : ''}`],
    ['Peers', st?.loaded ? `${st.peers.length} · ↓ ${formatSpeed(st.downloadSpeed)}` : null],
    ['On the NAS', st?.file ? `${Math.round(st.file.progress * 100)}% of this file` : null],
    ['Buffered', cur ? `${Math.max(0, Math.round(ahead))} s ahead` : null],
    ['ffmpeg', s ? `${s.speed ? `${s.speed.toFixed(1)}x` : '…'}${s.paused ? ', paused far enough ahead' : s.running ? '' : ', finished'}` : null],
  ].filter(([, value]) => value)
  fill($('#facts'), ...rows.flatMap(([k, value]) => [el('dt', { textContent: k }), el('dd', { textContent: value })]))
}

const caps = measureCaps(video, window)

const position = () => cur ? cur.offset + video.currentTime : pendingPosition

function persistProgress (force = false, ended = false) {
  if (!cur || video.readyState < 2) return
  const now = Date.now()
  if (!force && now - lastProgressSave < 5000) return
  // A growing HLS playlist's local duration is not the whole file duration.
  const duration = cur.duration ?? (cur.mode === 'direct' ? video.duration : null)
  const record = progressEntry(position(), duration, { ended, at: now })
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

/** Asks the server how to play from `at` seconds and loads the result. */
async function start (at = 0) {
  if (pageLife.signal.aborted) return
  const gen = ++generation
  pendingPosition = at
  teardown()
  const signal = (playLife = new AbortController()).signal
  const requestTab = tab
  const pageSignal = pageLife.signal
  const current = () => gen === generation && !signal.aborted
  notify('Starting…', 'busy')
  produced = 0
  cur = null
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
  } catch (err) {
    if (!current()) return
    cur = null
    return notify(err.message, 'error', err.status === 422 ? refusalActions() : [button('Try again', () => start(at), true), linkButton('Back to files', urls.torrent(ih))])
  }
  if (gen !== generation) return
  $('#seek').max = Math.floor(cur.duration || 0)
  const hlsMode = cur.mode !== 'direct'
  video.controls = !hlsMode
  $('#controls').hidden = !hlsMode

  if (!hlsMode) {
    video.src = cur.url
    if (at) video.currentTime = at
  } else {
    notify(cur.mode === 'transcode' ? 'Converting the video…' : 'Preparing the stream…', 'busy')
    try {
      await waitForPlaylist(cur.url, gen, signal)
    } catch (err) {
      return current() && notify(err.message, 'error', [button('Try again', () => start(at), true), ...refusalActions().slice(0, 1)])
    }
    if (gen !== generation) return
    // Safari plays HLS (and HEVC) natively; other browsers use hls.js
    if (!Hls.isSupported() || (navigator.vendor.includes('Apple') && video.canPlayType('application/vnd.apple.mpegurl'))) {
      video.src = cur.url
    } else {
      hls = new Hls({ startPosition: 0, maxBufferLength: 60 })
      hls.on(Hls.Events.ERROR, (_, data) => current() && data.fatal && notify(`Playback error: ${data.details}`, 'error', [button('Try again', () => start(position()), true)]))
      hls.loadSource(cur.url)
      hls.attachMedia(video)
    }
  }
  renderFacts()
  // Browsers may block autoplay with sound until the page has been clicked; start muted then
  video.play().then(() => current() && notify(''), () => {
    if (!current()) return
    video.muted = true
    video.play().then(() => current() && notify('Muted: autoplay with sound was blocked. Click the video or press M to unmute.'),
      () => current() && notify('Press play to start.'))
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
  throw new Error('ffmpeg produced nothing in 45 s. The torrent may be too slow; try again or pick another release.')
}

function seekTo (t) {
  if (!cur) return
  t = Math.max(0, Math.min(t, (cur.duration || Infinity) - 1))
  if (cur.mode === 'direct') {
    video.currentTime = t
    return
  }
  const rel = t - cur.offset
  if (rel >= 0 && rel < produced - 2) video.currentTime = rel
  else start(t) // outside what ffmpeg has made: restart it there
}

// Subtitles share one text track. Parsing is pure; polling, growing-file
// handling and HLS offset application remain owned by this page.
let subtitleRun = 0
async function loadSubtitles (gen = generation) {
  subtitleLife?.abort()
  const signal = (subtitleLife = new AbortController()).signal
  const run = ++subtitleRun
  for (const cue of [...(subTrack.cues ?? [])]) subTrack.removeCue(cue)
  const choice = $('#subs').value
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
    if (signal.aborted || gen !== generation || run !== subtitleRun || $('#subs').value !== choice) return
    const growing = url.startsWith('/hls/') && !cur.complete
    if (res?.ok) {
      let text
      try { text = await res.text() } catch {
        if (!signal.aborted) notify('Subtitle response was interrupted. Select the track again to retry.', 'warn')
        return
      }
      if (signal.aborted || gen !== generation || run !== subtitleRun || $('#subs').value !== choice) return
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

async function loadInfo (signal = pageLife.signal) {
  try {
    const result = await api(`/api/probe/${ih}/${idx}`, { signal })
    if (signal.aborted) return
    info = result
  } catch (err) {
    if (signal.aborted) return
    return notify(err.message, 'error', [button('Try again', () => location.reload(), true), linkButton('Back to files', urls.torrent(ih))])
  }
  const name = t => [t.language, t.title].filter(Boolean).join(' · ')
  $('#audio').replaceChildren(...info.audio.map(a =>
    new Option(`${a.index + 1}. ${name(a) || 'Track'} (${a.codec} ${a.channels}ch)`, a.index)))
  for (const s of info.subtitles) {
    const opt = new Option(`${name(s) || `Track ${s.index + 1}`} (${s.codec})${s.text ? '' : ' — image subtitles, not supported'}`, `embedded:${s.index}`)
    opt.disabled = !s.text
    $('#subs').add(opt)
  }
  for (const f of info.externalSubtitles) $('#subs').add(new Option(f.name, `file:${f.idx}`))
  const saved = resumePosition(recall(progressKey(ih, idx)), info.duration)
  pendingPosition = saved
  if (saved) {
    notify(`Resume from ${clock(saved)}?`, 'error', [
      button('Resume', () => start(saved), true),
      button('Start over', () => { remember(progressKey(ih, idx), progressEntry(0, info.duration)); start(0) }),
    ])
  } else start(0)
}

/** Every 2 s: keeps the ffmpeg session alive, updates the details panel and warns when ffmpeg can't keep up. */
async function pollStatus (signal = pageLife.signal) {
  let slow = false
  while (!signal.aborted) {
    try { await sleep(2000, signal) } catch { return }
    if (!cur) continue
    const q = new URLSearchParams({ idx, session: cur.session ?? '', pos: video.currentTime })
    const gen = generation
    const st = await api(`/api/torrents/${ih}/status?${q}`, { signal }).catch(() => null)
    if (signal.aborted || gen !== generation || !cur || !st?.loaded) continue
    lastStatus = st
    const s = st.session
    if (s) {
      produced = s.produced
      cur.complete = !s.running
      const nowSlow = s.running && !s.paused && s.speed && s.speed < 1 && s.produced - video.currentTime < 30
      if (s.failed) notify(`ffmpeg failed: ${s.error}`, 'error', [button('Try again', () => start(position()), true)])
      else if (nowSlow) notify(`The NAS converts at ${s.speed.toFixed(1)}x, slower than playback, so this will stall. Try another release.`, 'warn')
      else if (slow) notify('')
      slow = nowSlow
    }
    if ($('#details').open) renderFacts()
    if (st.file) {
      $('#pieces').style.background = st.file.ranges.length
        ? `linear-gradient(to right, ${st.file.ranges.flatMap(([a, b]) => [`transparent ${a * 100}%`, `var(--accent) ${a * 100}%`, `var(--accent) ${b * 100}%`, `transparent ${b * 100}%`]).join(', ')})`
        : 'transparent'
    }
  }
}

// Custom controls for HLS modes, where the native timeline only knows the current session
const seek = $('#seek')
let dragging = false
seek.addEventListener('input', () => { dragging = true; $('#time').textContent = `${clock(seek.value)} / ${clock(cur?.duration)}` })
seek.addEventListener('change', () => { dragging = false; seekTo(Number(seek.value)) })
video.addEventListener('timeupdate', () => {
  persistProgress()
  if (!cur || dragging) return
  seek.value = position()
  $('#time').textContent = `${clock(position())} / ${clock(cur.duration)}`
})
video.addEventListener('play', () => { $('#playpause').textContent = '❚❚' })
video.addEventListener('pause', () => { $('#playpause').textContent = '▶'; persistProgress(true) })
video.addEventListener('seeked', () => persistProgress(true))
video.addEventListener('waiting', () => cur && notify('Buffering…', 'busy'))
video.addEventListener('playing', () => {
  if (pageLife.signal.aborted) return
  persistProgress(true)
  if ($('#overlay .toast.busy')) notify('')
  // For "Continue" on the torrent page and the home page
  if (file) remember(`last:${ih}`, { idx, label: episodeLabel(file) || baseName(file.name), at: Date.now() })
})
video.addEventListener('error', () => cur?.mode === 'direct' && notify(`Playback error: ${video.error?.message || video.error?.code}`, 'error', refusalActions()))
video.addEventListener('ended', () => { persistProgress(true, true); countdownToNext() })
video.addEventListener('volumechange', () => {
  $('#mute').textContent = video.muted ? '🔇' : '🔊'
  if (!video.muted && $('#overlay .toast.notice')) notify('')
})
$('#mute').addEventListener('click', () => { video.muted = !video.muted })
$('#details').addEventListener('toggle', () => $('#details').open && renderFacts())
const togglePlay = () => video.paused ? video.play() : video.pause()
$('#playpause').addEventListener('click', togglePlay)
video.addEventListener('click', () => {
  if (video.muted) video.muted = false
  else if (!video.controls) togglePlay()
})
$('#fullscreen').addEventListener('click', () =>
  document.fullscreenElement ? document.exitFullscreen() : ($('#stage').requestFullscreen?.() ?? video.webkitEnterFullscreen?.()))
document.addEventListener('keydown', e => {
  if (e.target.matches('input, select') || !cur) return
  if (e.key === ' ') { e.preventDefault(); togglePlay() }
  if (e.key === 'ArrowRight') seekTo(position() + 10)
  if (e.key === 'ArrowLeft') seekTo(position() - 10)
  if (e.key === 'm') video.muted = !video.muted
})
$('#audio').addEventListener('change', e => { audio = Number(e.target.value); start(position()) })
$('#subs').addEventListener('change', () => loadSubtitles())
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
})

if (!/^[a-f0-9]{40}$/.test(ih ?? '') || !Number.isInteger(idx) || idx < 0) notify('This player link is incomplete. Open the file from its torrent page.', 'error', [linkButton('Search', '/')])
else {
  notify('Reading file info…', 'busy')
  loadTitle()
  loadInfo()
  pollStatus()
}
