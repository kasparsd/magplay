// The rows of the Player's ⓘ Details: how this file is being played, and how the torrent is doing.
import type { PlaybackDecision, ProbeResult, TorrentStatus } from '@magplay/api-contract'
import { audioFormat, containerLabel, languageName } from './naming.ts'
import { formatBytes, formatSpeed } from './format.ts'
import { baseName } from './urls.ts'

export interface FactsInput {
  decision: PlaybackDecision | null
  file: { name: string, size: number } | null | undefined
  info: ProbeResult | null
  /** The selected audio track's index. */
  audio: number
  status: TorrentStatus | null
  /** Seconds the browser has buffered past the playhead. */
  buffered: number
}

/** [label, value] pairs; facts that aren't known yet are left out. */
export function factRows ({ decision, file, info, audio, status, buffered }: FactsInput): Array<[string, string]> {
  const v = info?.video
  const a = info?.audio[audio]
  const s = status?.session
  const rows: Array<[string, string | null | undefined | false]> = [
    ['Mode', decision && `${decision.mode}: ${decision.reason}`],
    ['File', file && `${baseName(file.name)} (${formatBytes(file.size)})`],
    ['Container', containerLabel(info?.container, file?.name)],
    ['Video', v && `${v.codec}${v.profile ? ` ${v.profile}` : ''}, ${v.width}×${v.height}, ${(v.width * (v.sampleAspect || 1) / v.height).toFixed(2)}:1, ${v.bitDepth}-bit`],
    ['Audio', a && [audioFormat(a.codec, a.channels), languageName(a.language)].filter(Boolean).join(', ')],
    ['Peers', status?.loaded && `${status.peers.length} · ↓ ${formatSpeed(status.downloadSpeed)}`],
    ['On the server', status?.loaded && status.file && `${Math.round(status.file.progress * 100)}% of this file`],
    ['Buffered', decision && `${Math.max(0, Math.round(buffered))} s ahead`],
    ['ffmpeg', s && `${s.speed ? `${s.speed.toFixed(1)}x` : '…'}${s.paused ? ', paused far enough ahead' : s.running ? '' : ', finished'}`],
    ['Encoder', s?.encoder],
  ]
  return rows.filter((row): row is [string, string] => !!row[1])
}
