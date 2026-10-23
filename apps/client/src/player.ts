// The player page, /play/<infohash>/<file index>. One chrome over the video for every playback mode; the playback
// itself (sessions, hls.js, browser remux, subtitles, polling, the countdown) is the PlaybackController, and this page
// draws its snapshots. Each part of the page is redrawn only when the snapshot values it shows have changed, so open
// menus stay open and focus stays put.
import { icon } from './lib/icons.ts'
import { releaseName } from './lib/naming.ts'
import { performanceView } from './lib/performance.ts'
import { fileLabel, fileRanges, isLocal, nothingToPlay, PlaybackController, playbackSignals, sessionStatus } from './lib/playback-controller.ts'
import type { Overlay } from './lib/playback-controller.ts'
import { playbackPresentation } from './lib/playback-flow.ts'
import { playbackStatusView } from './lib/playback-status-view.ts'
import { factRows } from './lib/player-facts.ts'
import { keyCommand } from './lib/player-keys.ts'
import type { PlayerCommand } from './lib/player-keys.ts'
import { SPEEDS, speedLabel } from './lib/player-speed.ts'
import { audioTrackLabel, audioTrackName } from './lib/player-tracks.ts'
import { layerBackground, seekHint, seekOutcome } from './lib/seek.ts'
import { $, copyButton, el, episodeLabel, fill, formatClock as clock, menu, menuChoice, menuHeading, menuSeparator } from './lib/ui.ts'
import type { Child } from './lib/ui.ts'
import { baseName, playerApps, streamUrl, urls } from './lib/urls.ts'
import { parts } from './lib/view.ts'
import './lib/topbar.ts'

const video = $<HTMLVideoElement>('#video')
const stage = $('#stage')
const seek = $<HTMLInputElement>('#seek')
const [, , ih = '', idxPart] = location.pathname.split('/')
const idx = Number(idxPart)
const player = new PlaybackController({ ih, idx, video })
let snap = player.getSnapshot()
let flowPinned = false
let dragging = false

const button = (label: string, onclick: () => void, primary?: boolean): HTMLButtonElement => el('button', { type: 'button', className: `button${primary ? ' primary' : ''}`, textContent: label, onclick })
const linkButton = (label: string, href: string, primary?: boolean): HTMLAnchorElement => el('a', { className: `button${primary ? ' primary' : ''}`, href, textContent: label })

const { when, forget } = parts()
/** View state the snapshot doesn't have. Kept here and written to the DOM, never read back from it. */
const ui = { details: false, performance: false, keys: false }

const showPlaybackStatus = playbackStatusView($('#playback-status'), $('#playback-announcement'), name => {
  if (name === 'retry') return button('Try again', () => { player.retry() }, true)
  if (name === 'play') return button('Play', () => { player.togglePlay() }, true)
  if (name === 'release') return linkButton('Choose another release', urls.search(snap.torrent ? releaseName(snap.torrent.name) : ''))
  if (!snap.file) return null
  return menu('Open in player', [
    ...playerApps(ih, idx, snap.file.name).map(([text, href]) => el('a', { textContent: text, href })),
    copyButton('Copy stream link', streamUrl(ih, idx, snap.file.name)),
  ], { className: 'button playback-external' })
}, toggleFlowPin)

function toggleFlowPin (): void {
  flowPinned = !flowPinned
  render()
  wake()
}

function render (): void {
  snap = player.getSnapshot()
  const s = snap
  when('title', [s.torrent, s.file, s.next], renderTitle)
  when('aspect', [s.info], setAspect)
  when('overlay', [s.overlay], () => { renderOverlay(s.overlay) })
  if (s.active) renderPlaybackStatus()
  when('play', [s.media.paused, nothingToPlay(s)], renderPlayButton)
  when('volume', [s.media.muted, s.media.volume], renderVolume)
  when('audio', [s.info, s.audio], renderAudioMenu)
  when('subtitles', [s.subtitleOptions, s.subtitles], renderSubtitlesMenu)
  when('speed', [s.media.rate], renderSpeedMenu)
  when('more', [s.file, s.media.pip, s.media.rate, flowPinned], renderMore)
  if (ui.details) when('facts', [s.decision, s.file, s.info, s.audio, s.status], renderFacts)
  if (ui.performance) when('performance', [s.history, s.decision], renderPerformance)
  updateTimeline()
}

function renderPlaybackStatus (): void {
  const s = snap
  const model = playbackPresentation(playbackSignals(s), flowPinned)
  if (model && !s.file) model.actions = model.actions.filter(name => name !== 'external' && name !== 'release')
  const waiting = s.now - s.waitingAt
  showPlaybackStatus(model, waiting, s.starting ? `${s.starting} · Waiting ${Math.floor(waiting / 1000)} s` : '')
  stage.classList.toggle('has-playback-wait', !!model && model.kind !== 'warning' && model.kind !== 'debug' && model.key !== 'brief')
  if (model && model.kind !== 'warning' && model.kind !== 'debug') stage.classList.remove('idle')
}

/** Messages on the video: a chip ('busy' spinner, 'notice', 'warn') or a centred card with actions. */
function renderOverlay (overlay: Overlay | null): void {
  const box = $('#overlay')
  if (!overlay) return fill(box)
  const card = (text: string, ...actions: HTMLElement[]): void => fill(box, el('div', { className: 'card' }, el('p', { textContent: text }), el('p', { className: 'actions' }, ...actions)))
  switch (overlay.kind) {
    case 'resume':
      return card(`Resume from ${clock(overlay.at)}?`,
        button('Resume', () => { player.playFrom(overlay.at) }, true),
        button('Start over', () => { player.startOver() }))
    case 'countdown':
      return card(`Next: ${fileLabel(overlay.next)} in ${overlay.left} s`,
        linkButton('Play now', urls.player(ih, overlay.next.idx), true),
        button('Cancel', () => { player.cancelCountdown() }))
    case 'missing':
      // Retrying can't help, so offer only the way back and hide the empty controls
      ui.details = ui.performance = false
      for (const sel of ['#title-actions', '#details', '#performance', '#chrome']) $(sel).hidden = true
      return card(overlay.message, linkButton('Back to files', urls.torrent(ih), true))
    case 'busy': case 'notice': case 'warn':
      return fill(box, el('div', { className: `toast ${overlay.kind}` }, overlay.text))
  }
}

/** Names the page after the file, links back to its torrent, offers external players and the next episode. */
function renderTitle (): void {
  const { torrent: t, file, next } = snap
  $<HTMLAnchorElement>('#back').href = urls.torrent(ih)
  if (!t) return
  $('#back').textContent = `← ${t.name}`
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
  if (next) {
    const name = `Next: ${fileLabel(next)}`
    const link = $<HTMLAnchorElement>('#next')
    Object.assign(link, { href: urls.player(ih, next.idx), title: `${name} (N)`, hidden: false })
    link.setAttribute('aria-label', name)
    fill(link, el('span', { className: 'pill wide-only', textContent: name }), el('span', { className: 'narrow-only' }, icon('next')))
  }
}

/** The ⓘ panel: how this file is being played, and how the torrent is doing. */
function renderFacts (): void {
  const rows = factRows({ decision: snap.decision, file: snap.file ?? undefined, info: snap.info, audio: snap.audio, status: snap.status, buffered: snap.media.ahead })
  fill($('#facts'), ...rows.flatMap(([k, value]) => [el('dt', { textContent: k }), el('dd', { textContent: value })]))
}

/** Redrawn on each poll, only while the disclosure is open. */
function renderPerformance (): void {
  fill($('#performance'), ...performanceView(snap.history, { direct: isLocal(snap.decision) }))
}

// Chrome menus open upward and stay inside the stage, so they work in fullscreen too
const chromeMenu = (label: string | Node, items: Child[], ariaLabel: string, className = ''): HTMLDetailsElement => menu(label, items, { title: ariaLabel, ariaLabel, up: true, within: () => stage, className })

/** Tags a menu choice with the value it selects, for tests and debugging. */
const withValue = <E extends HTMLElement>(item: E, value: string | number): E => { item.dataset.value = String(value); return item }

function renderSubtitlesMenu (): void {
  const { subtitleOptions: options, subtitles: choice } = snap
  const current = options.find(o => o.value === choice)
  const name = `Subtitles: ${current ? current.name : 'Off'}`
  const box = $<HTMLDetailsElement>('#subs-slot details') ?? (fill($('#subs-slot'), chromeMenu(icon('subtitles'), [], name)), $<HTMLDetailsElement>('#subs-slot details'))
  const summary = $('summary', box)
  summary.setAttribute('aria-label', name)
  summary.title = `${name} (C)`
  summary.classList.toggle('on', !!current)
  fill($('.menu-items', box), menuHeading('Subtitles'), withValue(menuChoice('Off', !choice, () => { player.setSubtitles('') }), ''),
    ...options.map(o => withValue(menuChoice(o.label, o.value === choice, () => { player.setSubtitles(o.value) }, { disabled: o.disabled, title: o.disabled ? 'Image subtitles are not supported' : '' }), o.value)))
  $('#subs-slot').hidden = options.length === 0
}

function renderAudioMenu (): void {
  const tracks = snap.info?.audio ?? []
  const selected = tracks[snap.audio]
  const name = `Audio: ${selected ? audioTrackName(selected) : 'Track 1'}`
  fill($('#audio-slot'), chromeMenu(icon('audio'), [
    menuHeading('Audio'),
    ...tracks.map(a => withValue(menuChoice(audioTrackLabel(a), a.index === snap.audio, () => { player.setAudio(a.index) }), a.index)),
  ], name))
  $('#audio-slot').hidden = tracks.length < 2
}

const speedChoices = (): HTMLButtonElement[] => SPEEDS.map(rate => menuChoice(rate === 1 ? '1× (normal)' : speedLabel(rate), snap.media.rate === rate, () => { player.setSpeed(rate) }))

function renderSpeedMenu (): void {
  const rate = snap.media.rate
  fill($('#speed-slot'), chromeMenu(el('span', { className: 'pill', textContent: speedLabel(rate) }), [menuHeading('Speed'), ...speedChoices()], `Speed: ${speedLabel(rate)}`))
}

/** More: the same file actions as the torrent page's ⋯ menu, Picture in picture, the key list, and Speed on narrow screens. */
function renderMore (): void {
  const { file } = snap
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
    pip && el('button', { type: 'button', textContent: snap.media.pip ? 'Exit picture in picture' : 'Picture in picture', onclick: () => { player.togglePip() } }),
    el('button', { type: 'button', textContent: 'Keyboard shortcuts', onclick: () => { showKeys(true) } }),
    menuChoice('Playback flow', flowPinned, toggleFlowPin),
    narrow(menuSeparator()),
    narrow(menuHeading('Speed')),
    ...speedChoices().map(narrow),
  ]
  const box = $<HTMLDetailsElement>('#more-slot details')
  if (box) fill($('.menu-items', box), ...items)
  else fill($('#more-slot'), chromeMenu(icon('more'), items, 'More'))
}

/** The video's display aspect ratio from the probe, corrected for non-square pixels. */
function setAspect (): void {
  const v = snap.info?.video
  if (v?.width && v.height) stage.style.setProperty('--ar', String(v.width * (v.sampleAspect || 1) / v.height))
}

// The seek bar ------------------------------------------------------------

/** The four seek bar layers: on the server, converted by ffmpeg, in the browser, played. */
function drawSeekbar (): void {
  const { duration: total, buffered, position } = snap.media
  const layer = (id: string, value: string): void => { $(id).style.backgroundImage = value }
  if (!total) {
    for (const id of ['#layer-server', '#layer-conv', '#layer-buf']) layer(id, 'none')
    $('#layer-played').style.width = '0'
    return
  }
  layer('#layer-server', layerBackground(fileRanges(snap) ?? [], 'var(--seek-server)'))
  layer('#layer-conv', layerBackground((sessionStatus(snap)?.ready ?? []).map(([a, b]) => [a / total, b / total]), 'var(--seek-conv)'))
  layer('#layer-buf', layerBackground(snap.decision ? buffered.map(([a, b]) => [a / total, b / total]) : [], 'var(--seek-buf)'))
  $('#layer-played').style.width = `${Math.min(100, (dragging ? Number(seek.value) : position) / total * 100)}%`
}

/** Time, slider range and its spoken value; while dragging the slider shows where it will land. */
function updateTimeline (): void {
  const total = snap.media.duration
  const at = dragging ? Number(seek.value) : snap.media.position
  seek.max = String(Math.floor(total))
  if (!dragging) seek.value = String(at)
  seek.setAttribute('aria-valuetext', `${clock(at)} of ${clock(total)}`)
  $('#time').textContent = `${clock(at)} / ${clock(total)}`
  drawSeekbar()
}

/** The tooltip over the seek bar: the time under the pointer and what jumping there will do. */
function showTip (t: number, x: number): void {
  const tip = $('#seektip')
  const { decision, media } = snap
  if (!media.duration) return
  const outcome = decision
    ? seekOutcome(t, { mode: decision.mode, duration: media.duration, buffered: media.buffered, ready: sessionStatus(snap)?.ready ?? null, growingEnd: snap.growingEnd, ranges: fileRanges(snap) })
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
  const total = snap.media.duration
  return track.offsetLeft + (total ? t / total : 0) * track.offsetWidth
}

$('#seekbar').addEventListener('pointermove', e => {
  if (dragging) return
  const track = $('#seekbar .track').getBoundingClientRect()
  const fraction = Math.max(0, Math.min(1, (e.clientX - track.left) / track.width))
  showTip(fraction * snap.media.duration, e.clientX - $('#seekbar').getBoundingClientRect().left)
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
  player.seek(Number(seek.value))
})

// The chrome ---------------------------------------------------------------

// Visibility: shown while paused, while a menu is open, while focus is inside it, and for 2.5 s after the last pointer move, touch or key
let idleTimer = 0
function wake (): void {
  stage.classList.remove('idle')
  clearTimeout(idleTimer)
  idleTimer = setTimeout(sleepChrome, 2500)
}
function sleepChrome (): void {
  if (video.paused || !snap.decision || stage.classList.contains('has-playback-wait') || $('#stage details.menu[open]') || ui.keys || $('#stage :focus-visible') || dragging) return
  stage.classList.add('idle')
  hideTip()
}
stage.addEventListener('pointermove', e => { if (e.pointerType !== 'touch') wake() })
stage.addEventListener('pointerleave', e => { if (e.pointerType !== 'touch') { clearTimeout(idleTimer); sleepChrome() } })
stage.addEventListener('toggle', wake, true)
stage.addEventListener('focusin', wake)

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
  if (player.unmuteAutoplay()) return
  player.togglePlay()
})
video.addEventListener('dblclick', toggleFullscreen)
video.addEventListener('play', wake)
video.addEventListener('pause', wake)

function renderPlayButton (): void {
  const label = snap.media.paused ? 'Play' : 'Pause'
  const b = $<HTMLButtonElement>('#playpause')
  fill(b, icon(snap.media.paused ? 'play' : 'pause'))
  b.setAttribute('aria-label', label)
  b.title = `${label} (K)`
  b.disabled = nothingToPlay(snap)
}
$('#playpause').addEventListener('click', () => { player.togglePlay() })
$('#back10').addEventListener('click', () => { player.seekBy(-10) })
$('#fwd10').addEventListener('click', () => { player.seekBy(10) })
fill($('#back10'), icon('back'))
fill($('#fwd10'), icon('forward'))
fill($('#keys-close'), icon('close'))

function renderVolume (): void {
  const { muted, volume } = snap.media
  const silent = muted || volume === 0
  const label = silent ? 'Unmute' : 'Mute'
  const b = $('#mute')
  fill(b, icon(silent ? 'muted' : volume < 0.5 ? 'volumeLow' : 'volume'))
  b.setAttribute('aria-label', label)
  b.title = `${label} (M)`
  const slider = $<HTMLInputElement>('#volume')
  slider.value = String(silent ? 0 : volume)
  slider.style.setProperty('--vol', `${silent ? 0 : volume * 100}%`)
  slider.setAttribute('aria-valuetext', `${Math.round((silent ? 0 : volume) * 100)}%`)
}
$('#mute').addEventListener('click', () => { player.toggleMute() })
$<HTMLInputElement>('#volume').addEventListener('input', e => { player.setVolume(Number((e.target as HTMLInputElement).value)) })

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
function showKeys (open = !ui.keys): void {
  ui.keys = open
  $('#keys').hidden = !open
  if (open) $('#keys-close').focus()
  wake()
}
$('#keys-close').addEventListener('click', () => { showKeys(false) })

const commands: Record<PlayerCommand, () => void> = {
  playPause: () => { player.togglePlay() },
  back: () => { player.seekBy(-10) },
  forward: () => { player.seekBy(10) },
  volumeUp: () => { player.changeVolume(0.1) },
  volumeDown: () => { player.changeVolume(-0.1) },
  mute: () => { player.toggleMute() },
  fullscreen: toggleFullscreen,
  subtitles: () => { player.toggleSubtitles() },
  next: () => { player.playNext() },
  slower: () => { player.stepSpeed(-1) },
  faster: () => { player.stepSpeed(1) },
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
  if (e.key === 'Escape' && ui.keys) { showKeys(false); return }
  if (!snap.decision) return
  const command = keyCommand(e.key)
  if (!command) return
  e.preventDefault() // no page scroll, and the seek slider doesn't also move by one step
  commands[command]()
})

/** ⓘ Details and other disclosures under the title row: a button that shows and hides its panel. */
function disclosure (toggle: HTMLElement, panel: HTMLElement, key: 'details' | 'performance', part: string): void {
  toggle.addEventListener('click', () => {
    ui[key] = !ui[key]
    panel.hidden = !ui[key]
    toggle.setAttribute('aria-expanded', String(ui[key]))
    forget(part)
    render()
  })
}
disclosure($('#details-toggle'), $('#details'), 'details', 'facts')
disclosure($('#perf-toggle'), $('#performance'), 'performance', 'performance')

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

addEventListener('pagehide', () => { player.suspend() })
addEventListener('pageshow', e => { if (e.persisted) player.activate() })

renderFullscreen()
if (!/^[a-f0-9]{40}$/.test(ih) || !Number.isInteger(idx) || idx < 0) {
  render()
  fill($('#overlay'), el('div', { className: 'card' }, el('p', { textContent: 'This player link is incomplete. Open the file from its torrent page.' }), el('p', { className: 'actions' }, linkButton('Search', '/'))))
} else {
  player.subscribe(render)
  player.activate()
  render()
}
