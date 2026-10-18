import { test } from 'node:test'
import assert from 'node:assert/strict'
import { explainPlayback } from './playback-status.ts'
import type { PlaybackSignals } from './playback-status.ts'
import type { SessionStats, TorrentStatus } from '@magplay/api-contract'

const session = (over: Partial<SessionStats> = {}): SessionStats => ({
  id: 's',
  mode: 'transcode',
  speed: 0.5,
  fps: 12,
  cpu: null,
  produced: 20,
  readyUntil: 0,
  running: true,
  paused: false,
  failed: false,
  error: null,
  ...over,
})
const status = (over: Partial<Extract<TorrentStatus, { loaded: true }>> = {}): TorrentStatus => ({
  loaded: true,
  preparation: null,
  session: session(),
  activeStreams: 1,
  downloadSpeed: 0,
  uploadSpeed: 0,
  downloaded: 100,
  length: 100,
  progress: 1,
  files: [{ idx: 0, progress: 1 }],
  peers: [],
  file: { idx: 0, progress: 1, ranges: [[0, 1]] },
  ...over,
})
const signals = (over: Partial<PlaybackSignals> = {}): PlaybackSignals => ({
  phase: 'buffering',
  decision: { mode: 'transcode', reason: 'MPEG4 → H.264', offset: 60, duration: 90, url: '/hls/s/index.m3u8', session: 's', subtitles: [] },
  status: status(),
  statusAge: 0,
  waitingMs: 9000,
  buffer: 0,
  position: 0,
  rate: 1,
  slowSamples: 3,
  problem: null,
  ...over,
})

test('complete cached input and sustained insufficient output distinguish conversion from downloads', () => {
  const model = explainPlayback(signals())!
  assert.equal(model.key, 'slow')
  assert.deepEqual(model.actions, ['external', 'release'])
  assert.ok(model.evidence.includes('File fully downloaded'))
  // No claim about CPU, which this evidence does not establish.
  assert.doesNotMatch(model.description, /CPU/)
  assert.equal(explainPlayback(signals({ slowSamples: 2 }))?.key, 'conversion')
  assert.equal(explainPlayback(signals({ status: status({ session: session({ speed: null }) }) }))?.key, 'conversion')
  assert.equal(explainPlayback(signals({ status: status({ session: session({ paused: true }) }) }))?.key, 'conversion')
})

test('rounded 100% is incomplete, and zero peers does not mean a dead swarm', () => {
  const model = explainPlayback(signals({ status: status({ file: { idx: 0, progress: 0.9999, ranges: [] } }) }))!
  assert.equal(model.key, 'peers')
  assert.ok(model.evidence.includes('99% on the server'))
  assert.deepEqual(model.actions, ['release'])
  assert.doesNotMatch(model.description, /dead/)
})

test('published segments, not ffmpeg timestamps, distinguish conversion and browser buffering', () => {
  assert.equal(explainPlayback(signals({ slowSamples: 0, status: status({ session: session({ produced: 50, readyUntil: 0 }) }) }))?.key, 'conversion')
  assert.equal(explainPlayback(signals({ status: status({ session: session({ readyUntil: 24 }) }) }))?.key, 'browser')
  // Position is session relative even when the absolute offset is nonzero.
  assert.equal(explainPlayback(signals({ position: 25, status: status({ session: session({ readyUntil: 24 }) }) }))?.key, 'slow')
})

test('capacity is relative to playback rate and only warns with a small remaining buffer', () => {
  const faster = status({ session: session({ speed: 1.5, readyUntil: 5 }) })
  assert.equal(explainPlayback(signals({ phase: 'playing', status: faster, rate: 1 })), null)
  assert.equal(explainPlayback(signals({ phase: 'playing', status: faster, rate: 2 }))?.kind, 'warning')
  assert.equal(explainPlayback(signals({ phase: 'playing', buffer: 45 })), null)
  assert.equal(explainPlayback(signals({ phase: 'playing', status: status({ session: session({ readyUntil: 120 }) }) })), null)
  assert.equal(explainPlayback(signals({ phase: 'playing', status: status({ session: session({ running: false }) }) })), null)
})

test('initial quiet state, explicit preparation phases, unknown and stale diagnostics', () => {
  assert.equal(explainPlayback(signals({ waitingMs: 500 }))?.key, 'brief')
  assert.equal(explainPlayback(signals({ decision: null, status: { loaded: false, session: null, preparation: 'loading-file' } }))?.key, 'file')
  assert.equal(explainPlayback(signals({ decision: null, status: status({ preparation: 'loading-file', file: { idx: 0, progress: 0, ranges: [] } }) }))?.key, 'file')
  assert.equal(explainPlayback(signals({ decision: null, status: status({ preparation: 'probing' }) }))?.key, 'probe')
  assert.equal(explainPlayback(signals({ statusAge: 6001 }))?.key, 'unknown')
  assert.equal(explainPlayback(signals({ statusAge: 6001, phase: 'playing' })), null)
  assert.equal(explainPlayback(signals({ decision: null, status: null }))?.key, 'decision')
  assert.equal(explainPlayback(signals({ status: null, slowSamples: 0 }))?.key, 'conversion')
})

test('failed and lost sessions are actionable; deliberate pauses and resume prompts are silent', () => {
  assert.equal(explainPlayback(signals({ status: status({ session: null }) }))?.key, 'session-lost')
  assert.equal(explainPlayback(signals({ status: status({ session: session({ failed: true, error: 'Encoder failed', running: false }) }) }))?.description, 'Encoder failed')
  assert.equal(explainPlayback(signals({ phase: 'paused' })), null)
  assert.equal(explainPlayback(signals({ phase: 'idle' })), null)
  assert.equal(explainPlayback(signals({ phase: 'blocked' }))?.key, 'autoplay')
  assert.equal(explainPlayback(signals({ phase: 'error', problem: { title: 'Cannot play', description: 'Unsupported', actions: ['external'] } }))?.description, 'Unsupported')
})
