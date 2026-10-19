// A presentation of the existing diagnosis, with independent observations for each
// stage. Working concurrently is different from being the diagnosed wait.
import { formatSpeed } from './format.ts'
import { explainPlayback } from './playback-status.ts'
import type { PlaybackExplanation, PlaybackSignals } from './playback-status.ts'

export type FlowStageId = 'torrent' | 'server' | 'prepare' | 'player'
export type FlowState = 'pending' | 'working' | 'waiting' | 'ready' | 'bypassed' | 'unknown' | 'failed'
export interface FlowStage {
  id: FlowStageId
  name: string
  state: FlowState
  label: string
  metric: string
  detail: string
  /** Measured fraction of selected-file source bytes, never playback readiness. */
  progress: number | null
  transfer: string
}
export interface PlaybackFlow {
  stages: FlowStage[]
  focus: FlowStageId | null
  mode: string
}
export interface PlaybackPresentation extends Omit<PlaybackExplanation, 'kind'> {
  kind: PlaybackExplanation['kind'] | 'debug'
  flow: PlaybackFlow
  pinned: boolean
}

const WAITS: Record<string, FlowStageId> = {
  peers: 'torrent',
  download: 'torrent',
  file: 'server',
  probe: 'server',
  decision: 'server',
  conversion: 'prepare',
  slow: 'prepare',
  capacity: 'prepare',
  'conversion-error': 'prepare',
  'session-lost': 'prepare',
  browser: 'player',
  autoplay: 'player',
}

export function playbackFlow (input: PlaybackSignals, reason: PlaybackExplanation | null): PlaybackFlow {
  const { decision, phase, buffer, rate, position } = input
  const fresh = input.statusAge <= 6000
  const status = fresh ? input.status : null
  const torrent = status?.loaded ? status : input.source && input.source.age <= 6000 ? input.source.status : null
  const file = torrent?.file
  // A previous session's published segments cannot make this attempt ready.
  const session = decision?.session && status?.session?.id === decision.session ? status.session : null
  const local = decision?.mode === 'direct' || decision?.mode === 'browser-remux'
  const remux = decision?.mode === 'browser-remux' ? input.remux ?? null : null
  const complete = file?.progress === 1
  const ahead = session ? Math.max(0, session.readyUntil - position) : 0
  const focus = reason ? WAITS[reason.key] ?? null : null
  const make = (id: FlowStageId, name: string, state: FlowState, label: string, metric: string, detail: string, progress: number | null = null, transfer = ''): FlowStage =>
    ({ id, name, state, label, metric, detail, progress, transfer })
  const stages = [
    make('torrent', 'Torrent', !torrent ? 'unknown' : complete ? 'ready' : torrent.peers.length ? 'working' : 'waiting',
      !torrent ? 'Unknown' : complete ? 'Local' : `${torrent.peers.length} peers`,
      !torrent ? 'Download rate unavailable' : complete ? 'No source transfer needed' : `${formatSpeed(torrent.downloadSpeed)} · ${torrent.peers.length} connected peers`,
      !torrent ? 'Waiting for current source information.' : complete ? 'The selected file is fully downloaded.' : 'Download rate covers the entire torrent. Connected peers are not a seeder count.',
      null, !torrent ? '—' : complete ? 'Local' : formatSpeed(torrent.downloadSpeed)),
    make('server', 'Server', status?.preparation ? 'working' : complete ? 'ready' : file ? 'pending' : 'unknown',
      status?.preparation === 'loading-file' ? 'Checking' : status?.preparation === 'probing' ? 'Inspecting' : file ? `${complete ? 100 : Math.min(99, Math.floor(file.progress * 100))}% local` : 'Unknown',
      status?.preparation === 'loading-file' ? 'Loading and checking cached data' : status?.preparation === 'probing' ? 'Inspecting video and audio tracks' : file ? complete ? 'File fully downloaded' : `${Math.min(99, Math.floor(file.progress * 100))}% of this file on the server` : 'File availability unavailable',
      status?.preparation ? 'Completion of this check is not measured.' : 'Source byte completion is not a percentage of playback readiness.',
      file && !status?.preparation ? file.progress : null),
    decision?.mode === 'browser-remux'
      ? make('prepare', 'Prepare', !remux ? 'pending' : remux.done || remux.ahead >= rate ? 'ready' : 'working',
        !remux ? 'Starting' : remux.done ? 'Done' : remux.ahead >= rate ? 'Ready' : 'Repackaging',
        !remux ? 'Reading the file in this browser' : `${remux.speed == null ? '' : `${remux.speed.toFixed(1)}× conversion · `}${Math.floor(remux.ahead)} s ready ahead`,
        'This browser copies the video and converts the audio itself; the server only serves the file.',
        null, !remux ? '—' : remux.done ? 'Done' : remux.speed == null ? '—' : `${remux.speed.toFixed(1)}×`)
      : make('prepare', 'Prepare', local ? 'bypassed' : !fresh ? 'unknown' : !decision ? 'pending' : !session ? 'unknown' : session.failed ? 'failed' : ahead >= rate ? 'ready' : session.running ? 'working' : 'waiting',
        local ? 'Bypassed' : !fresh ? 'Unknown' : !decision ? 'Pending' : !session ? 'Pending' : session.failed ? 'Failed' : session.paused ? 'Ahead · idle' : ahead >= rate ? 'Ready' : decision.mode === 'transcode' ? 'Converting' : 'Preparing',
        local ? 'No conversion required' : !session ? 'Waiting for current session information' : session.failed ? 'Conversion stopped' : `${session.speed == null || session.paused ? '' : `${session.speed.toFixed(1)}× conversion · `}${Math.floor(ahead)} s ready ahead`,
        local ? 'The browser supports the original format.' : session?.failed ? 'Conversion stopped. Retry or open the original in another player.' : session?.paused ? 'Conversion resumes automatically when playback catches up.' : 'Only published playable segments count as ready ahead.',
        null, local ? 'Direct' : !session ? '—' : session.failed ? 'Stopped' : session.paused ? 'Idle' : session.speed == null ? '—' : `${session.speed.toFixed(1)}×`),
    make('player', 'Player', phase === 'blocked' ? 'waiting' : phase === 'error' ? 'unknown' : phase === 'playing' || (phase === 'paused' && buffer > 0) ? 'ready' : decision ? focus === 'player' ? 'working' : 'waiting' : 'pending',
      phase === 'blocked' ? 'Press play' : phase === 'error' ? 'Stopped' : phase === 'playing' ? 'Playing' : phase === 'paused' ? 'Paused' : decision ? 'Buffering' : 'Pending',
      `${Math.max(0, Math.floor(buffer))} s buffered · playback at ${rate}×`,
      phase === 'blocked' ? 'Press Play to allow browser playback.' : phase === 'playing' || phase === 'paused' ? 'Buffered video is measured from the current playback position.' : 'Delivery or decoding may be responsible; media delivery rate is not measured.'),
  ]
  // Attribute only observed failures. An unrelated failed request has no known location.
  if (focus && reason?.kind === 'error') {
    const stage = stages.find(stage => stage.id === focus)
    if (stage) { stage.state = 'failed'; stage.label = 'Failed' }
  }
  return { stages, focus, mode: !decision ? 'Selecting playback' : decision.mode === 'direct' ? 'Direct playback' : decision.mode === 'browser-remux' ? 'Browser repackaging' : decision.mode === 'transcode' ? 'Video conversion' : 'Stream preparation' }
}

export function playbackPresentation (input: PlaybackSignals, pinned: boolean): PlaybackPresentation | null {
  // Exclude mismatched session telemetry from diagnosis as well as stage readiness.
  const status = input.status
  const safe = status?.session && status.session.id !== input.decision?.session
    ? { ...input, status: null }
    : input
  const reason = explainPlayback(safe)
  if (!reason && (!pinned || input.phase === 'idle')) return null
  const flow = playbackFlow(safe, reason)
  if (reason) return { ...reason, flow, pinned }
  return {
    key: input.phase === 'paused' ? 'paused' : 'playing',
    kind: 'debug',
    pinned,
    flow,
    title: input.phase === 'paused' ? 'Playback paused' : 'Playback flow',
    description: 'A check means ready for playback; work can continue in parallel.',
    actions: [],
    evidence: [],
    facts: [
      ['Playback mode', input.decision ? `${input.decision.mode}: ${input.decision.reason}` : 'Selecting playback'],
      ['Playback speed', `${input.rate}×`],
      ['Status', input.statusAge > 6000 ? 'Server status unavailable or out of date' : 'Current server status'],
    ],
  }
}
