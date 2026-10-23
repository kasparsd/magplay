import { randomUUID } from 'node:crypto'
import { noopLogger, noopMetrics, outcome } from '@magplay/observability'
import type { Logger, Metrics, OperationContext } from '@magplay/observability'
// Playback: probe → decide → a direct /raw URL, or an HLS session for the player's tab whose playlist covers the
// whole file (segments cut on the keyframes from the file's index when the video is copied).
import { decide } from '@magplay/playback'
import type { MediaTools, PlaybackPolicy } from '@magplay/playback'
import type { TorrentEngine } from '@magplay/torrent-engine'
import type { PlaybackDecision, PlaybackPreparation, PlayRequest, ProbeResult } from '@magplay/api-contract'
import { HttpError } from '../http/errors.ts'
import type { Tabs } from './tabs.ts'

export interface PlayOptions {
  logger?: Logger
  metrics?: Metrics
  engine: TorrentEngine
  media: MediaTools
  tabs: Tabs
  policy: () => PlaybackPolicy
  /** The /raw loopback URL ffmpeg and ffprobe read a torrent file from. */
  input: (ih: string, idx: number) => string
}

export interface Play {
  /** `cancelled` reports a request the browser gave up on, so no session starts for nobody. */
  play: (request: PlayRequest, cancelled: () => boolean, context?: OperationContext) => Promise<PlaybackDecision>
  /** GET /api/probe: the file's tracks and the torrent's external subtitle files. */
  probe: (ih: string, idx: number, context?: OperationContext) => Promise<ProbeResult>
  preparation: (ih: string, idx: number) => PlaybackPreparation | null
}

export function createPlay ({ engine, media, tabs, policy, input, logger = noopLogger, metrics = noopMetrics }: PlayOptions): Play {
  // Requests share file/probe work. Reference counts keep one caller finishing
  // from clearing another caller's phase; entries disappear even on failure.
  const pending = new Map<string, Record<PlaybackPreparation, number>>()
  async function during<T> (ih: string, idx: number, phase: PlaybackPreparation, job: () => Promise<T>, log: Logger = logger): Promise<T> {
    const key = `${ih}/${idx}`
    const counts = pending.get(key) ?? { 'loading-file': 0, probing: 0 }
    pending.set(key, counts)
    counts[phase]++
    const started = performance.now()
    try { return await job() } finally {
      const durationMs = performance.now() - started
      log[durationMs > 1000 ? 'info' : 'debug']('playback.stage.completed', { stage: phase, durationMs })
      counts[phase]--
      if (!counts['loading-file'] && !counts.probing) pending.delete(key)
    }
  }
  return {
    preparation (ih, idx) {
      const counts = pending.get(`${ih}/${idx}`)
      return counts?.probing ? 'probing' : counts?.['loading-file'] ? 'loading-file' : null
    },
    async play ({ ih, idx, audio = 0, start = 0, tab, caps = {} }, cancelled, context) {
      const started = performance.now()
      const log = (context?.logger ?? logger).child({ component: 'playback', operationId: randomUUID(), torrentId: ih, fileIndex: idx, startSeconds: start, audioIndex: audio })
      log.info('playback.requested')
      let mode = 'unknown'
      let result: ReturnType<typeof outcome> = 'success'
      let sessionId: string | undefined
      try {
        const check = (): void => { if (cancelled()) throw new HttpError(499, 'Playback request cancelled') }
        check()
        const file = await during(ih, idx, 'loading-file', () => engine.file(ih, idx, { logger: log }), log)
        check()
        const info = await during(ih, idx, 'probing', () => media.probe(input(ih, idx), file.name, { logger: log }), log)
        check()
        let decision
        try {
          decision = decide(info, caps, policy(), audio)
        } catch (err) {
          log.warn('playback.refused', { reason: err instanceof Error ? err.name : 'unknown' })
          throw err
        }
        mode = decision.mode
        log.info('playback.decided', { mode, reason: decision.reason })
        const { reason } = decision
        if (decision.mode === 'direct') {
          tabs.stop(tab)
          return { mode: 'direct', reason, duration: info.duration, url: `/raw/${ih}/${idx}` }
        }
        const keyframes = decision.mode === 'remux' ? await during(ih, idx, 'probing', () => media.keyframes(input(ih, idx), file.length, { logger: log }), log) : null
        check()
        const s = tabs.start(tab, {
          input: input(ih, idx),
          info,
          audio,
          start,
          mode: decision.mode,
          keyframes,
          context: { logger: log },
          onReady: () => {
            const durationMs = performance.now() - started
            metrics.ready(decision.mode, durationMs / 1000)
            log.info('playback.ready', { mode: decision.mode, sessionId, durationMs })
          }
        })
        sessionId = s.id
        return {
          mode: decision.mode,
          reason,
          duration: info.duration,
          url: `/hls/${s.id}/index.m3u8`,
          session: s.id,
          growing: s.growing,
          // Text subtitles are written by the same ffmpeg runs, on the file's timeline
          subtitles: info.subtitles.filter(t => t.text).map(t => ({ index: t.index, url: `/hls/${s.id}/sub_${t.index}.vtt` })),
        }
      } catch (err) {
        result = outcome(err)
        log[result === 'cancelled' ? 'debug' : 'warn']('playback.failed', { outcome: result, reason: err instanceof Error ? err.name : 'unknown' })
        throw err
      } finally {
        const durationMs = performance.now() - started
        metrics.playback(mode, result, durationMs / 1000)
        log.info(result === 'success' ? mode === 'direct' ? 'playback.ready' : 'playback.prepared' : 'playback.completed', { mode, outcome: result, durationMs, sessionId })
      }
    },
    async probe (ih, idx, context) {
      const log = (context?.logger ?? logger).child({ component: 'probe', operationId: randomUUID(), torrentId: ih, fileIndex: idx })
      const torrent = await during(ih, idx, 'loading-file', () => engine.get(ih, { logger: log }), log)
      const file = torrent.files[idx]
      if (!file) throw new HttpError(404, 'No such file in this torrent')
      const info = await during(ih, idx, 'probing', () => media.probe(input(ih, idx), file.name, { logger: log }), log)
      const { files } = engine.describe(torrent)
      return { ...info, externalSubtitles: files.filter(f => f.isSub).map(f => ({ idx: f.idx, name: f.name })) }
    },
  }
}
