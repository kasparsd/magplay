// Playback: probe → decide → a direct /raw URL or an HLS session for the player's tab.
import { decide } from '@magplay/playback'
import type { MediaTools, PlaybackPolicy } from '@magplay/playback'
import type { TorrentEngine } from '@magplay/torrent-engine'
import type { PlaybackDecision, PlayRequest, ProbeResult } from '@magplay/api-contract'
import { HttpError } from '../http/errors.ts'
import type { Tabs } from './tabs.ts'

export interface PlayOptions {
  engine: TorrentEngine
  media: MediaTools
  tabs: Tabs
  policy: () => PlaybackPolicy
  /** The /raw loopback URL ffmpeg and ffprobe read a torrent file from. */
  input: (ih: string, idx: number) => string
}

export interface Play {
  /** `cancelled` reports a request the browser gave up on, so no session starts for nobody. */
  play: (request: PlayRequest, cancelled: () => boolean) => Promise<PlaybackDecision>
  /** GET /api/probe: the file's tracks and the torrent's external subtitle files. */
  probe: (ih: string, idx: number) => Promise<ProbeResult>
}

export function createPlay ({ engine, media, tabs, policy, input }: PlayOptions): Play {
  return {
    async play ({ ih, idx, audio = 0, start = 0, tab, caps = {} }, cancelled) {
      const check = (): void => { if (cancelled()) throw new HttpError(499, 'Playback request cancelled') }
      check()
      const file = await engine.file(ih, idx)
      check()
      const info = await media.probe(input(ih, idx), file.name)
      check()
      let decision
      try {
        decision = decide(info, caps, policy(), audio)
      } catch (err) {
        console.log(`[play] refused ${ih}/${idx} ${file.name}: ${err instanceof Error ? err.message : String(err)}`)
        throw err
      }
      console.log(`[play] ${decision.mode} ${ih}/${idx} ${file.name} @${start.toFixed(0)}s: ${decision.reason}`)
      const { reason, mode } = decision
      if (mode === 'direct') {
        tabs.stop(tab)
        return { mode, reason, duration: info.duration, url: `/raw/${ih}/${idx}`, offset: 0 }
      }
      const s = tabs.start(tab, { input: input(ih, idx), info, audio, start, mode })
      return {
        mode,
        reason,
        duration: info.duration,
        url: `/hls/${s.id}/index.m3u8`,
        session: s.id,
        offset: start,
        // Text subtitles are written by the same ffmpeg, timed relative to the session start
        subtitles: info.subtitles.filter(t => t.text).map(t => ({ index: t.index, url: `/hls/${s.id}/sub_${t.index}.vtt` })),
      }
    },
    async probe (ih, idx) {
      const torrent = await engine.get(ih)
      const file = torrent.files[idx]
      if (!file) throw new HttpError(404, 'No such file in this torrent')
      const info = await media.probe(input(ih, idx), file.name)
      const { files } = engine.describe(torrent)
      return { ...info, externalSubtitles: files.filter(f => f.isSub).map(f => ({ idx: f.idx, name: f.name })) }
    },
  }
}
