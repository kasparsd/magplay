// Pure diagnosis: distinguish observed stages without pretending that low output
// speed proves CPU overload, or that byte progress maps exactly to media time.
import type { PlaybackDecision, TorrentStatus } from '@magplay/api-contract'

export type PlaybackPhase = 'loading' | 'starting' | 'playlist' | 'buffering' | 'playing' | 'paused' | 'blocked' | 'idle' | 'error'
export type PlaybackAction = 'external' | 'release' | 'retry' | 'play'
export interface PlaybackProblem { title: string, description: string, actions: PlaybackAction[] }
export interface PlaybackSignals {
  phase: PlaybackPhase
  decision: PlaybackDecision | null
  status: TorrentStatus | null
  statusAge: number
  waitingMs: number
  buffer: number
  position: number
  rate: number
  slowSamples: number
  problem: PlaybackProblem | null
  /** Recent source-only observation retained through a seek/session restart. */
  source?: { status: Extract<TorrentStatus, { loaded: true }>, age: number }
  /** The in-page conversion's progress in browser-remux mode. */
  remux?: { ahead: number, speed: number | null, done: boolean }
}
export interface PlaybackExplanation extends PlaybackProblem {
  key: string
  kind: 'waiting' | 'warning' | 'error'
  evidence: string[]
  facts: Array<[string, string]>
}

export function explainPlayback (input: PlaybackSignals): PlaybackExplanation | null {
  const { phase, decision, status, statusAge, buffer, position, rate, slowSamples, waitingMs, problem } = input
  if (phase === 'idle' || phase === 'paused') return null
  const fresh = statusAge <= 6000
  const st = fresh && status?.loaded ? status : null
  const file = st?.file
  const complete = file?.progress === 1
  const s = fresh ? status?.session : null
  const ahead = s ? Math.max(0, s.readyUntil - position) : 0
  const slow = !!(complete && s?.running && !s.paused && s.speed != null && s.speed < rate && slowSamples >= 3)
  const evidence = [
    ...(file ? [complete ? 'File fully downloaded' : `${Math.min(99, Math.floor(file.progress * 100))}% on the server`] : []),
    ...(s?.speed != null ? [`${s.speed.toFixed(1)}× conversion`] : []),
    ...(decision ? [`${Math.max(0, Math.floor(buffer))} s buffered`] : []),
  ]
  const facts: Array<[string, string]> = [
    ...(decision ? [['Playback mode', `${decision.mode}: ${decision.reason}`] as [string, string]] : []),
    ...(st ? [['Torrent', `${st.peers.length} connected peers · ${Math.round(st.downloadSpeed / 1000)} KB/s download`] as [string, string]] : []),
    ...(s ? [['Published stream', `${Math.floor(ahead)} s ahead of the playhead`] as [string, string]] : []),
    ['Playback speed', `${rate}×`],
    ['Status', fresh ? status ? 'Current server status' : 'Waiting for the first server status' : 'Server status unavailable or out of date'],
  ]
  const result = (key: string, title: string, description: string, actions: PlaybackAction[] = [], kind: PlaybackExplanation['kind'] = 'waiting'): PlaybackExplanation =>
    ({ key, title, description, actions, kind, evidence: kind === 'warning' ? evidence.slice(complete ? 1 : 0) : evidence, facts })
  if (phase === 'error' && problem) return result('error', problem.title, problem.description, problem.actions, 'error')
  if (s?.failed) return result('conversion-error', 'Video conversion stopped', s.error || 'The server could not finish converting this file.', ['retry', 'external'], 'error')
  if (phase === 'blocked') return result('autoplay', 'Press play to start', 'Your browser blocked automatic playback. Press play to continue.', ['play'])
  // Insufficient capacity while video is still playing is a small advisory, not a stall.
  if (phase === 'playing') {
    return slow && ahead < 30 * rate && buffer < 30 * rate
      ? result('capacity', 'Conversion is falling behind', 'The server is converting more slowly than your selected playback speed.', ['external'], 'warning')
      : null
  }
  if (waitingMs < 1000) return result('brief', 'Preparing playback…', '')
  if (!fresh) return result('unknown', 'Playback is waiting', 'The latest playback status is unavailable. Checking again automatically.')
  if (decision?.session && status && !status.session) {
    return result('session-lost', 'The playback session ended', 'The prepared stream is no longer available. Try again to start a new session.', ['retry', 'external'], 'error')
  }
  // During cache verification, unverified local pieces can temporarily look
  // incomplete. The explicit preparation phase takes precedence over peers.
  if (!decision && status?.preparation === 'loading-file') {
    return result('file', 'Loading the file', 'Loading torrent information and checking the data available on the server.')
  }
  if (file && !complete && buffer < 1) {
    if (!st?.peers.length) return result('peers', 'Waiting for peers', 'The file is incomplete and no peers are connected. Still looking for a source.', ['release'])
    const ranges = file.ranges ?? []
    const tailPresent = ranges.some(([, end]) => end >= 0.999)
    const stalled = (st?.downloadSpeed ?? 0) === 0
    if (!tailPresent && stalled) {
      return result('tail', 'Waiting for the end of the file',
        'This file is still downloading and its video index is stored at the end, so playback cannot start until peers send the tail. Try an external player or a release with faststart (web-optimized) metadata.',
        ['external', 'release'])
    }
    return result('download', 'Waiting for torrent data', 'This file is still downloading. More source data may be needed before playback can continue.', ['release'])
  }
  if (!decision) {
    if (status?.preparation === 'probing') return result('probe', 'Checking the file format', 'Reading the video and audio tracks to find the best way to play this file in your browser.')
    return result('decision', 'Preparing playback', 'Waiting for the server to select a playback mode.')
  }
  if (slow && ahead < 3 * rate) {
    return result('slow', decision.mode === 'transcode' ? 'Converting video too slowly' : 'Preparing the stream too slowly',
      'The file is fully downloaded, but the server is preparing video more slowly than your selected playback speed.', ['external', 'release'])
  }
  if (decision.mode === 'browser-remux' && buffer < 1 && (input.remux?.ahead ?? 0) < 1 && !input.remux?.done) {
    return result('conversion', 'Repackaging in the browser', 'This browser is reading the file and preparing its audio itself. Waiting for playable media.')
  }
  if (decision.session && ahead < 1) {
    return result('conversion', decision.mode === 'transcode' ? 'Converting the video' : 'Preparing the stream',
      decision.mode === 'transcode'
        ? 'This browser needs a different video format. Waiting for playable converted segments.'
        : 'Repackaging the file and preparing its audio for your browser. Waiting for playable segments.')
  }
  if (st && (complete || ahead > 1)) {
    return result('browser', 'Waiting for the browser to buffer',
      ahead > 1
        ? 'The server has prepared video ahead of your position. Waiting for the browser to receive and play it.'
        : 'The file is available on the server. Waiting for the browser to receive and play it.', ['external'])
  }
  return result('waiting', 'Playback is waiting', 'Waiting for enough playable video. Checking the source, prepared stream and browser buffer.')
}
