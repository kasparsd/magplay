import { mock, test } from 'node:test'
import assert from 'node:assert/strict'
import type { PlaybackDecision, ProbeResult, TorrentInfo } from '@magplay/api-contract'
import { PlaybackController } from './playback-controller.ts'
import type { PlaybackDeps, PlayerSnapshot } from './playback-controller.ts'
import { ApiError } from './api.ts'

const ih = 'a'.repeat(40)
const info: ProbeResult = {
  duration: 90,
  startTime: 0,
  container: 'mp4',
  isWebm: false,
  audio: [
    { index: 0, codec: 'aac', channels: 2, language: 'eng', title: null, default: true },
    { index: 1, codec: 'aac', channels: 2, language: 'fra', title: null, default: false },
  ],
  subtitles: [],
  externalSubtitles: [],
}
const file = (idx: number) => ({ idx, name: `Show.S01E0${idx + 1}.mp4`, size: 1, isVideo: true, isSub: false, isProgram: false, season: 1, episode: idx + 1 })
const torrent: TorrentInfo = { infoHash: ih, name: 'Show', files: [file(0), file(1)], warning: null }
const direct = (url = `/raw/${ih}/0`): PlaybackDecision => ({ mode: 'direct', reason: 'plays as is', duration: 90, url })

/** Just enough of a video element: events, play()/pause() and the properties the controller reads. */
class FakeVideo extends EventTarget {
  src = ''
  currentTime = 0
  duration = NaN
  readyState = 0
  paused = true
  ended = false
  playbackRate = 1
  defaultPlaybackRate = 1
  volume = 1
  muted = false
  controls = true
  error = null
  buffered = { length: 0, start: () => 0, end: () => 0 }
  seekable = { length: 0, start: () => 0, end: () => 0 }
  track = { mode: 'hidden', cues: [], addCue () {}, removeCue () {} }
  addTextTrack () { return this.track }
  canPlayType () { return '' }
  removeAttribute () { this.src = '' }
  load () {}
  play () {
    this.paused = false
    this.readyState = 4
    this.dispatchEvent(new Event('playing'))
    return Promise.resolve()
  }

  pause () {
    this.paused = true
    this.dispatchEvent(new Event('pause'))
  }
}

/** A fake API: each request waits for the test to answer it, and rejects when its signal aborts. */
function fakeApi () {
  const pending: Array<{ url: string, body: unknown, signal: AbortSignal | null | undefined, resolve: (value: unknown) => void, reject: (err: unknown) => void }> = []
  const api = ((url: string, options: { json?: unknown, signal?: AbortSignal | null } = {}) => new Promise<unknown>((resolve, reject) => {
    pending.push({ url, body: options.json, signal: options.signal, resolve, reject })
    options.signal?.addEventListener('abort', () => { reject(new DOMException('Aborted', 'AbortError')) }, { once: true })
  })) as PlaybackDeps['api']
  /** The oldest unanswered request for `path`, or under it when `path` ends with a slash. */
  async function next (path: string) {
    const matches = (url: string): boolean => path.endsWith('/') ? url.startsWith(path) : url.split('?')[0] === path
    for (let i = 0; i < 50; i++) {
      const index = pending.findIndex(r => matches(r.url))
      if (index >= 0) return pending.splice(index, 1)[0]!
      await new Promise(resolve => setImmediate(resolve))
    }
    throw new Error(`no request for ${path}; pending: ${pending.map(r => r.url).join(', ')}`)
  }
  return {
    api,
    pending,
    next,
    async respond (path: string, value: unknown) { (await next(path)).resolve(value) },
  }
}

function setup () {
  const server = fakeApi()
  const video = new FakeVideo()
  const beacons: string[] = []
  const visits: string[] = []
  const player = new PlaybackController({
    ih,
    idx: 0,
    video: video as unknown as HTMLVideoElement,
    navigate: url => { visits.push(url) },
    deps: {
      api: server.api,
      fetch: () => Promise.reject(new Error('no subtitles here')),
      beacon: url => { beacons.push(url) },
      caps: { h264: 'probably' } as unknown as PlaybackDeps['caps'],
      browserRemux: true,
      mediaSession: null,
    },
  })
  return { server, video, beacons, visits, player }
}

/** Waits until the controller's snapshot passes `check`. */
async function until (player: PlaybackController, check: (s: PlayerSnapshot) => boolean): Promise<PlayerSnapshot> {
  for (let i = 0; i < 50; i++) {
    const s = player.getSnapshot()
    if (check(s)) return s
    await new Promise(resolve => setImmediate(resolve))
  }
  assert.fail(`snapshot never matched: ${JSON.stringify({ phase: player.getSnapshot().phase, overlay: player.getSnapshot().overlay })}`)
}

test('activation probes, asks for playback with its tab, and plays the decision', async () => {
  const { server, video, player } = setup()
  let notified = 0
  player.subscribe(() => { notified++ })
  player.activate()
  assert.equal(player.getSnapshot().phase, 'loading')
  await server.respond(`/api/torrents/${ih}`, torrent)
  await server.respond('/api/probe/', info)
  const play = await server.next('/api/play')
  const { tab, ...body } = play.body as { tab: unknown }
  assert.deepEqual(body, { ih, idx: 0, audio: 0, start: 0, caps: { h264: 'probably' }, browserRemux: true })
  assert.equal(typeof tab, 'string')
  play.resolve(direct())
  const s = await until(player, s => s.phase === 'playing')
  assert.equal(video.src, `/raw/${ih}/0`)
  assert.equal(s.decision?.mode, 'direct')
  assert.equal(s.next?.idx, 1, 'the next video in the torrent')
  assert.ok(notified > 0)
  // Snapshots are stable until something changes
  assert.equal(player.getSnapshot(), player.getSnapshot())
  player.dispose()
})

test('an audio switch while the first request is pending closes the stale session and keeps only the latest', async () => {
  const { server, beacons, player } = setup()
  player.activate()
  await server.respond('/api/probe/', info)
  const first = await server.next('/api/play')
  player.setAudio(1)
  first.resolve({ mode: 'remux', reason: 'r', duration: 90, url: '/hls/one/index.m3u8', session: 'one', growing: false, subtitles: [] })
  const second = await server.next('/api/play')
  assert.equal((second.body as { audio: number }).audio, 1)
  assert.deepEqual(beacons, ['/api/play/one'], 'the superseded session is stopped')
  second.resolve(direct())
  const s = await until(player, s => s.decision !== null)
  assert.equal(s.decision?.url, `/raw/${ih}/0`)
  assert.equal(s.audio, 1)
  player.dispose()
})

test('leaving during the probe starts nothing; a restored activation is a new tab and plays', async () => {
  const { server, beacons, player } = setup()
  player.activate()
  const probe = await server.next('/api/probe/')
  const firstTab = beacons.length
  player.suspend()
  probe.resolve(info) // too late: its signal was aborted
  assert.equal(beacons.length, firstTab + 1)
  const closedTab = beacons.at(-1)
  assert.match(closedTab ?? '', /^\/api\/play\/tab\//)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(server.pending.filter(r => r.url === '/api/play').length, 0)

  player.activate()
  await server.respond('/api/probe/', info)
  const play = await server.next('/api/play')
  assert.notEqual(`/api/play/tab/${(play.body as { tab: string }).tab}`, closedTab, 'a restored activation uses a new tab id')
  play.resolve(direct())
  await until(player, s => s.phase === 'playing')
  player.dispose()
})

test('a file the torrent does not have asks to go back instead of retrying', async () => {
  const { server, player } = setup()
  player.activate()
  ;(await server.next('/api/probe/')).reject(new ApiError('No such file', 404))
  const s = await until(player, s => s.overlay?.kind === 'missing')
  assert.equal(s.phase, 'idle')
  player.dispose()
})

test('a failed playback request is an error with Try again, and retry plays from where it was', async () => {
  const { server, player } = setup()
  player.activate()
  await server.respond('/api/probe/', info)
  ;(await server.next('/api/play')).reject(new ApiError('Busy', 503))
  const s = await until(player, s => s.phase === 'error')
  assert.deepEqual(s.problem?.actions, ['retry', 'external'])
  player.retry()
  await server.respond('/api/play', direct())
  await until(player, s => s.phase === 'playing' && s.problem === null)
  player.dispose()
})

test('the speed notice clears itself, but not a message that replaced it', () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const { player } = setup()
    player.stepSpeed(1)
    assert.deepEqual(player.getSnapshot().overlay, { kind: 'notice', text: 'Speed 1.25×' })
    assert.equal(player.getSnapshot().media.rate, 1.25)
    mock.timers.tick(1200)
    assert.equal(player.getSnapshot().overlay, null)

    player.stepSpeed(-1)
    ;(player as unknown as { setOverlay: (o: unknown) => void }).setOverlay({ kind: 'warn', text: 'Other' })
    mock.timers.tick(1200)
    assert.deepEqual(player.getSnapshot().overlay, { kind: 'warn', text: 'Other' })
    player.dispose()
  } finally { mock.timers.reset() }
})

test('the end of a video counts down to the next one; playing again cancels it', async () => {
  const { server, video, visits, player } = setup()
  player.activate()
  await server.respond(`/api/torrents/${ih}`, torrent)
  await server.respond('/api/probe/', info)
  await server.respond('/api/play', direct())
  await until(player, s => s.phase === 'playing')
  mock.timers.enable({ apis: ['setInterval'] })
  try {
    video.dispatchEvent(new Event('ended'))
    assert.deepEqual(player.getSnapshot().overlay, { kind: 'countdown', next: file(1), left: 10 })
    mock.timers.tick(3000)
    assert.equal((player.getSnapshot().overlay as { left: number }).left, 7)
    video.dispatchEvent(new Event('play'))
    assert.equal(player.getSnapshot().overlay, null)
    mock.timers.tick(10_000)
    assert.deepEqual(visits, [])

    video.dispatchEvent(new Event('ended'))
    mock.timers.tick(10_000)
    assert.deepEqual(visits, [`/play/${ih}/1`])
  } finally {
    mock.timers.reset()
    player.dispose()
  }
})
