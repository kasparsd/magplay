import { test } from 'node:test'
import assert from 'node:assert/strict'
import { explainPlayback } from './playback-status.ts'
import type { PlaybackSignals } from './playback-status.ts'
import type { SessionStats, TorrentStatus } from '@magplay/api-contract'
import { playbackPresentation } from './playback-flow.ts'

const session = (over: Partial<SessionStats> = {}): SessionStats => ({
  id: 's',
  mode: 'transcode',
  speed: 0.5,
  fps: 12,
  cpu: null,
  produced: 20,
  readyUntil: 0,
  ready: [],
  growing: false,
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
  decision: { mode: 'transcode', reason: 'MPEG4 → H.264', duration: 90, url: '/hls/s/index.m3u8', session: 's', growing: false, subtitles: [] },
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

test('incomplete file with connected peers but missing tail and stalled download names the tail', () => {
  const model = explainPlayback(signals({
    decision: null,
    status: status({ peers: [{ address: null, client: null, downloadSpeed: 0, uploadSpeed: 0, downloaded: 0, uploaded: 0, share: 0.5, choking: false }], file: { idx: 0, progress: 0.9, ranges: [[0, 0.9]] }, downloadSpeed: 0 }),
    buffer: 0,
  }))!
  assert.equal(model.key, 'tail')
  assert.deepEqual(model.actions, ['external', 'release'])
  assert.match(model.description, /video index is stored at the end/)
})

test('incomplete file with connected peers and present tail keeps the general download message', () => {
  const model = explainPlayback(signals({
    decision: null,
    status: status({ peers: [{ address: null, client: null, downloadSpeed: 1000, uploadSpeed: 0, downloaded: 0, uploaded: 0, share: 0.5, choking: false }], file: { idx: 0, progress: 0.9, ranges: [[0, 1]] }, downloadSpeed: 1000 }),
    buffer: 0,
  }))!
  assert.equal(model.key, 'download')
})

test('published segments, not ffmpeg timestamps, distinguish conversion and browser buffering', () => {
  assert.equal(explainPlayback(signals({ slowSamples: 0, status: status({ session: session({ produced: 50, readyUntil: 0 }) }) }))?.key, 'conversion')
  assert.equal(explainPlayback(signals({ status: status({ session: session({ readyUntil: 24 }) }) }))?.key, 'browser')
  // Position and readyUntil are both on the file's timeline.
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

test('flow separates selected-file completion from torrent completion and playback readiness', () => {
  const model = playbackPresentation(signals({ status: status({ progress: 1, file: { idx: 0, progress: 0.9999, ranges: [] } }) }), false)!
  assert.equal(model.flow.focus, 'torrent')
  assert.equal(model.flow.stages[1]?.progress, 0.9999)
  assert.equal(model.flow.stages[1]?.label, '99% local')
  assert.notEqual(model.flow.stages[0]?.state, 'ready')
  assert.equal(model.flow.stages[2]?.progress, null)
  assert.equal(model.flow.stages[3]?.progress, null)
})

test('cached input and published output distinguish concurrent readiness from completion', () => {
  const model = playbackPresentation(signals({ status: status({ session: session({ readyUntil: 42, running: true }) }) }), false)!
  assert.equal(model.flow.focus, 'player')
  assert.deepEqual(model.flow.stages.map(stage => stage.state), ['ready', 'ready', 'ready', 'working'])
  assert.match(model.flow.stages[2]!.metric, /42 s ready ahead/)
  const slow = playbackPresentation(signals(), false)!
  assert.equal(slow.flow.focus, 'prepare')
  assert.equal(slow.flow.stages[2]?.state, 'working')
  assert.equal(slow.flow.stages[3]?.state, 'waiting')
})

test('debug pin shows healthy direct, paused, and throttled playback without blocking waits', () => {
  const direct = signals({ phase: 'playing', decision: { mode: 'direct', reason: 'Supported', duration: 90, url: '/raw' }, status: status({ session: null }), buffer: 30 })
  assert.equal(playbackPresentation(direct, false), null)
  const model = playbackPresentation(direct, true)!
  assert.equal(model.kind, 'debug')
  assert.deepEqual(model.flow.stages.map(stage => stage.state), ['ready', 'ready', 'bypassed', 'ready'])
  assert.equal(playbackPresentation({ ...direct, phase: 'paused' }, true)?.key, 'paused')
  const ahead = playbackPresentation(signals({ phase: 'playing', status: status({ session: session({ paused: true, readyUntil: 240 }) }) }), true)!
  assert.equal(ahead.kind, 'debug')
  assert.equal(ahead.flow.stages[2]?.label, 'Ahead · idle')
  assert.doesNotMatch(ahead.flow.stages[2].metric, /0.5×/)
  assert.equal(playbackPresentation({ ...direct, phase: 'idle' }, true), null)
})

test('stale status clears upstream checks while preserving direct mode and browser observations', () => {
  const stale = playbackPresentation(signals({ statusAge: 6001 }), false)!
  assert.equal(stale.flow.focus, null)
  assert.deepEqual(stale.flow.stages.slice(0, 3).map(stage => stage.state), ['unknown', 'unknown', 'unknown'])
  assert.equal(stale.flow.stages[1]?.progress, null)
  const direct = playbackPresentation(signals({ phase: 'playing', decision: { mode: 'direct', reason: 'Supported', duration: 90, url: '/raw' }, statusAge: 6001, buffer: 12 }), true)!
  assert.equal(direct.flow.stages[2]?.state, 'bypassed')
  assert.equal(direct.flow.stages[3]?.state, 'ready')
})

test('an old session cannot make a restarted conversion ready or diagnose its failure', () => {
  const model = playbackPresentation(signals({ status: status({ session: session({ id: 'old', readyUntil: 240, failed: true }) }) }), false)!
  assert.notEqual(model.kind, 'error')
  assert.notEqual(model.flow.stages[2]?.state, 'ready')
  assert.doesNotMatch(model.flow.stages[2]!.metric, /240/)
  const seek = playbackPresentation(signals({ position: 42, status: status({ session: session({ readyUntil: 24 }) }), slowSamples: 0 }), false)!
  assert.equal(seek.flow.focus, 'prepare')
  assert.equal(seek.flow.stages[2]?.state, 'working')
  assert.equal(seek.flow.stages[0]?.state, 'ready')
})

test('flow attributes explicit conversion failures but leaves unrelated request failures unlocated', () => {
  const failed = playbackPresentation(signals({ status: status({ session: session({ failed: true, running: false }) }) }), false)!
  assert.equal(failed.flow.focus, 'prepare')
  assert.equal(failed.flow.stages[2]?.state, 'failed')
  const unknown = playbackPresentation(signals({ phase: 'error', problem: { title: 'Request failed', description: 'Network request failed', actions: ['retry'] } }), false)!
  assert.equal(unknown.flow.focus, null)
  assert.ok(unknown.flow.stages.every(stage => stage.state !== 'failed'))
  const autoplay = playbackPresentation(signals({ phase: 'blocked' }), false)!
  assert.equal(autoplay.flow.focus, 'player')
  assert.equal(autoplay.flow.stages[3]?.state, 'waiting')
})

test('seek restart retains recent source availability without retaining session readiness', () => {
  const cached = status({ session: null })
  assert.equal(cached.loaded, true)
  if (!cached.loaded) throw new Error('Fixture source must be loaded')
  const restarting = signals({ phase: 'starting', decision: null, status: null, source: { status: cached, age: 2000 } })
  const model = playbackPresentation(restarting, false)!
  assert.deepEqual(model.flow.stages.slice(0, 3).map(stage => stage.state), ['ready', 'ready', 'pending'])
  const expired = playbackPresentation({ ...restarting, source: { status: cached, age: 6001 } }, false)!
  assert.deepEqual(expired.flow.stages.slice(0, 3).map(stage => stage.state), ['unknown', 'unknown', 'pending'])
})
