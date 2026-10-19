import { randomUUID } from 'node:crypto'
import { noopLogger, noopMetrics, outcome } from '@magplay/observability'
import type { Logger, Metrics, OperationContext } from '@magplay/observability'
// Playback: probe → decide → a direct /raw URL or an HLS session for the player's tab.
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

/** Whether an MP4 stores its `moov` (index) box before `mdat` (media data) — a "faststart"/web-optimized file.
 *  Files without it can't start playing until the trailing metadata arrives, which on a torrent may take
 *  the whole download. Reads only the leading bytes and never throws. */
async function isFaststart (file: { read?: (start: number, end: number, signal: AbortSignal) => AsyncIterable<Uint8Array> }, signal: AbortSignal): Promise<boolean> {
  if (typeof file.read !== 'function') return true
  const LIMIT = 8 * 1024 * 1024
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for await (const c of file.read(0, LIMIT - 1, signal)) {
      chunks.push(c)
      total += c.length
      if (total >= LIMIT) break
    }
  } catch {
    return true
  }
  const buf = new Uint8Array(Math.min(total, LIMIT))
  let off = 0
  for (const c of chunks) {
    const n = Math.min(c.length, buf.length - off)
    buf.set(c.subarray(0, n), off)
    off += n
    if (off >= buf.length) break
  }
  let pos = 0
  while (pos + 8 <= buf.length) {
    let size = (buf[pos]! << 24) >>> 0 | (buf[pos + 1]! << 16) | (buf[pos + 2]! << 8) | buf[pos + 3]!
    const type = String.fromCharCode(buf[pos + 4]!, buf[pos + 5]!, buf[pos + 6]!, buf[pos + 7]!)
    if (size === 1) {
      if (pos + 16 > buf.length) break
      size = 0
      for (let i = 0; i < 8; i++) size = size * 256 + buf[pos + 8 + i]!
      /* header = 16 */
    } else if (size === 0) {
      size = buf.length - pos
    }
    if (size < 8) break
    if (type === 'moov') return true
    if (type === 'mdat') return false
    if (pos + size > buf.length) break
    pos += size
  }
  return true
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
        // Non-faststart MP4s can't begin decoding until their trailing `moov` atom arrives, which on a
        // torrent may mean waiting for the whole file. Remux instead so playback starts from the head.
        if (decision.mode === 'direct' && !info.isWebm && /mp4|mov/.test(info.container)) {
          const fast = await isFaststart(file, new AbortController().signal)
          if (!fast) {
            decision = { mode: 'remux' as const, reason: 'MP4 index is at the end of the file; remuxing so playback can start before the file is fully downloaded' }
          }
        }
        mode = decision.mode
        log.info('playback.decided', { mode, reason: decision.reason })
        const { reason } = decision
        if (decision.mode === 'direct') {
          tabs.stop(tab)
          return { mode: 'direct', reason, duration: info.duration, url: `/raw/${ih}/${idx}`, offset: 0 }
        }
        // Copied video begins at the keyframe before the request. Report that time as the session origin so the
        // clock and subtitles match the picture; the player seeks the remainder inside the session.
        const origin = decision.mode === 'remux' && start > 0 ? await media.keyframeBefore(input(ih, idx), start) : start
        check()
        const s = tabs.start(tab, {
          input: input(ih, idx),
          info,
          audio,
          start: origin,
          mode: decision.mode,
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
          offset: origin,
          // Text subtitles are written by the same ffmpeg, timed relative to the session start
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
