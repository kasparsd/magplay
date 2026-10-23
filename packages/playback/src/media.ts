import { randomUUID } from 'node:crypto'
import { noopLogger, noopMetrics, observeJob } from '@magplay/observability'
import type { Logger, Metrics, OperationContext } from '@magplay/observability'
// What a file holds (ffprobe), how this browser should play it, and the ffmpeg work behind it.
// Inputs are URLs or paths; the app passes its /raw loopback URL.
import { execFile } from 'node:child_process'
import type { AudioTrack, BrowserCapabilities, ProbeResult, SubtitleTrack, VideoCodecKey, VideoTrack } from '@magplay/api-contract'
import { MediaToolError, NoSuchTrackError, PlaybackBusyError, UnplayableError } from './errors.ts'
import { createLimiter } from './limits.ts'
import { keyframeIndex } from './keyframes.ts'
import type { ReadRange } from './keyframes.ts'
import { SEGMENT_SECONDS } from './plan.ts'

/** ffprobe's summary of a file, as the player API sends it (without the torrent's external subtitles). */
export type MediaInfo = Omit<ProbeResult, 'externalSubtitles'>

export type PlaybackMode = 'direct' | 'remux' | 'transcode'

export interface Decision {
  mode: PlaybackMode
  reason: string
}

/** Server policy for files the browser can't play as they are. */
export interface PlaybackPolicy {
  allowTranscode: boolean
  /** Transcoded height in pixels, e.g. 720. */
  transcodeMaxHeight: number
}

const TEXT_SUBS = new Set(['subrip', 'srt', 'ass', 'ssa', 'webvtt', 'mov_text', 'text'])
const VIDEO_KEYS: Readonly<Record<string, VideoCodecKey>> = { h264: 'h264', hevc: 'hevc', vp9: 'vp9', av1: 'av1' }
const AUDIO_KEYS: Readonly<Record<string, keyof BrowserCapabilities>> = { aac: 'aac', ac3: 'ac3', eac3: 'eac3', opus: 'opus', flac: 'flac' }
const VIDEO_NAMES: Readonly<Record<string, string>> = { h264: 'H.264', hevc: 'HEVC', vp9: 'VP9', av1: 'AV1' }

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const record = (v: unknown): Record<string, unknown> => isRecord(v) ? v : {}
const str = (v: unknown): string | undefined => typeof v === 'string' ? v : undefined
const int = (v: unknown): number => typeof v === 'number' && Number.isFinite(v) ? v : 0

/** ffprobe's sample_aspect_ratio ("64:45") as a number; unset, "0:1" and malformed values mean square pixels. */
export function sampleAspect (value: unknown): number {
  const [num = 0, den = 0] = (typeof value === 'string' ? value : '').split(':').map(Number)
  return num > 0 && den > 0 ? num / den : 1
}

/** ffprobe's -show_format -show_streams JSON as MediaInfo; anything that isn't such a summary throws MediaToolError. */
export function parseProbe (data: unknown, fileName: string): MediaInfo {
  if (!isRecord(data) || (data.streams !== undefined && !Array.isArray(data.streams))) {
    throw new MediaToolError('ffprobe returned an invalid media summary')
  }
  const format = record(data.format)
  const streams = (Array.isArray(data.streams) ? data.streams as unknown[] : []).map(record)
  const tags = (s: Record<string, unknown>): Record<string, unknown> => record(s.tags)
  const disposition = (s: Record<string, unknown>): Record<string, unknown> => record(s.disposition)
  const lang = (s: Record<string, unknown>): string | null => {
    const language = str(tags(s).language)
    return language && language !== 'und' ? language : null
  }
  const v = streams.find(s => s.codec_type === 'video' && !disposition(s).attached_pic)
  const video: VideoTrack | undefined = v && {
    codec: str(v.codec_name) ?? '',
    tag: str(v.codec_tag_string) ?? '',
    profile: str(v.profile) ?? null,
    width: int(v.width),
    height: int(v.height),
    sampleAspect: sampleAspect(v.sample_aspect_ratio),
    bitDepth: Number(v.bits_per_raw_sample) || (/1[02]le|p010/.test(str(v.pix_fmt) ?? '') ? 10 : 8),
  }
  return {
    duration: Number(format.duration) || Number(v?.duration) || null,
    startTime: Number(format.start_time) || 0,
    container: str(format.format_name) ?? '',
    isWebm: /\.webm$/i.test(fileName),
    ...(video && { video }),
    audio: streams.filter(s => s.codec_type === 'audio').map((s, i): AudioTrack => ({
      index: i, codec: str(s.codec_name) ?? '', channels: int(s.channels), language: lang(s), title: str(tags(s).title) ?? null, default: !!disposition(s).default,
    })),
    subtitles: streams.filter(s => s.codec_type === 'subtitle').map((s, i): SubtitleTrack => {
      const codec = str(s.codec_name) ?? ''
      return { index: i, codec, language: lang(s), title: str(tags(s).title) ?? null, text: TEXT_SUBS.has(codec) }
    }),
  }
}

export interface ToolOptions {
  ffprobePath?: string
  ffmpegPath?: string
}

const lastLine = (text: string): string => text.trim().split('\n').pop() ?? ''

/** ffprobe summary of a file or URL (an HTTP input is read with Range requests). */
export function probe (input: string, fileName: string, { ffprobePath = 'ffprobe' }: ToolOptions = {}): Promise<MediaInfo> {
  const args = ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', input]
  return new Promise((resolve, reject) => {
    execFile(ffprobePath, args, { timeout: 120_000, maxBuffer: 16 * 1024 ** 2 }, (err, stdout, stderr) => {
      if (err) return reject(new MediaToolError(`ffprobe failed: ${err.killed ? 'timed out waiting for data' : lastLine(stderr)}`))
      let data: unknown
      try { data = JSON.parse(stdout) } catch { return reject(new MediaToolError('ffprobe returned invalid JSON')) }
      try { resolve(parseProbe(data, fileName)) } catch (parseError) { reject(parseError instanceof Error ? parseError : new MediaToolError(String(parseError))) }
    })
  })
}

/** What decide() reads from a MediaInfo. */
export interface DecideInput {
  container: string
  isWebm: boolean
  video?: Pick<VideoTrack, 'codec' | 'bitDepth' | 'tag'> | null | undefined
  audio: ReadonlyArray<Pick<AudioTrack, 'codec'>>
}

/** Picks direct play, remux or transcode for this browser and `audio` track. */
export function decide (info: DecideInput, caps: Partial<BrowserCapabilities>, policy: PlaybackPolicy, audio = 0): Decision {
  const v = info.video
  if (!v) throw new UnplayableError('No video stream found in this file.')
  const a = info.audio[audio]
  if (!Number.isInteger(audio) || audio < 0 || (info.audio.length && !a)) {
    throw new NoSuchTrackError('No such audio track')
  }
  const vKey = VIDEO_KEYS[v.codec]
  const vName = (VIDEO_NAMES[v.codec] || v.codec.toUpperCase()) + (v.bitDepth > 8 ? ` ${v.bitDepth}-bit` : '')
  // Browsers don't decode 10-bit H.264 (Hi10P)
  const videoOk = !!(vKey && caps[vKey] && !(vKey === 'h264' && v.bitDepth > 8))
  const audioKey = a && AUDIO_KEYS[a.codec]
  const audioOk = !a || !!(audioKey && caps[audioKey])
  const container = info.isWebm ? 'webm' : /mp4|mov/.test(info.container) ? 'mp4' : null
  const containerOk = container === 'webm'
    ? (vKey === 'vp9' || vKey === 'av1') && (!a || ['opus', 'vorbis'].includes(a.codec))
    : container === 'mp4' && (vKey === 'h264' || vKey === 'hevc' || vKey === 'av1') && !(vKey === 'hevc' && v.tag === 'hev1')

  if (videoOk && audioOk && containerOk && (audio === 0 || info.audio.length <= 1)) {
    return { mode: 'direct', reason: `${vName}${a ? ' + ' + a.codec : ''} in ${container} plays natively` }
  }
  if (videoOk) {
    const why = [!containerOk && `repackaging ${info.container.split(',')[0]}`, a && a.codec !== 'aac' && `converting ${a.codec} audio to AAC`]
    return { mode: 'remux', reason: `copying ${vName} video; ${why.filter(Boolean).join(', ') || 'switching audio track'}` }
  }
  if (policy.allowTranscode) {
    return { mode: 'transcode', reason: `this browser can't play ${vName}; re-encoding to H.264 ${policy.transcodeMaxHeight}p (slow on this server)` }
  }
  const safari = vKey === 'hevc' && v.bitDepth <= 10 ? ', open it in Safari,' : ''
  throw new UnplayableError(`This file is ${vName}. This browser can't play it and this server is too slow to convert it. Open it in an external player (VLC, IINA, Infuse…)${safari} or choose an x264 release.`)
}

/** fMP4 timestamps are the file's own plus this, so no run's early audio or B-frame reordering falls below zero. */
export const TIMELINE_OFFSET = 10

export interface FfmpegArgsOptions {
  input: string
  info: Pick<MediaInfo, 'audio' | 'subtitles' | 'startTime'> & { video?: Pick<VideoTrack, 'codec'> | undefined }
  audio: number
  /** Where this run starts on the file's timeline, in seconds (see runStart() for how segments choose it). */
  start: number
  mode: 'remux' | 'transcode'
  /** Where WebVTT files for text subtitles go. */
  dir: string
  transcodeMaxHeight: number
}

/**
 * ffmpeg arguments for one HLS run: fragmented MP4 on fd 3 with a fragment at every keyframe, progress on stdout, and
 * a WebVTT file per text subtitle track. Timestamps stay on the file's timeline whichever point a run starts from:
 * `-ss` counts from the file's start time, so the seek is `start - startTime`, and the output offset puts the
 * first frame back at `start` (plus TIMELINE_OFFSET for the media; subtitles get the plain file time).
 * Copied video keeps every packet from the keyframe ffmpeg lands on (no accurate seek), so audio isn't cut short;
 * transcoded video seeks exactly and forces a keyframe at every segment boundary.
 */
export function ffmpegArgs ({ input, info, audio, start, mode, dir, transcodeMaxHeight }: FfmpegArgsOptions): string[] {
  const a = info.audio[audio]
  const seek = start - info.startTime
  const time = (t: number): string => String(Math.round(t * 1e6) / 1e6) // microseconds, without float noise
  const video = mode === 'transcode'
    ? ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23', '-pix_fmt', 'yuv420p',
        '-vf', `scale=-2:'min(${transcodeMaxHeight},ih)'`, '-g', '48', '-keyint_min', '48', '-sc_threshold', '0',
        '-force_key_frames', `expr:gte(t,n_forced*${SEGMENT_SECONDS})`]
    : ['-c:v', 'copy', ...(info.video?.codec === 'hevc' ? ['-tag:v', 'hvc1'] : [])]
  const audioArgs = !a ? [] : a.codec === 'aac' ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-ac', '2', '-b:a', '192k']
  const subs = info.subtitles.filter(s => s.text).flatMap(s =>
    ['-map', `0:s:${s.index}`, '-c:s', 'webvtt', '-output_ts_offset', time(start), '-flush_packets', '1', '-f', 'webvtt', `${dir}/sub_${s.index}.vtt`])
  return [
    '-hide_banner', '-nostdin', '-loglevel', 'warning', '-progress', 'pipe:1',
    ...(mode === 'remux' ? ['-noaccurate_seek'] : []),
    // FLV can't seek even to 0 and would skip to the next keyframe
    ...(seek > 0 ? ['-ss', time(seek)] : []), '-i', input,
    '-map', '0:v:0', ...(a ? ['-map', `0:a:${audio}`] : []),
    ...video, ...audioArgs,
    '-output_ts_offset', time(start + TIMELINE_OFFSET),
    '-f', 'mp4', '-movflags', '+frag_keyframe+empty_moov+default_base_moof+frag_discont+negative_cts_offsets', '-use_editlist', '0', 'pipe:3',
    ...subs,
  ]
}

/** Converts a subtitle track (embedded stream N, or a whole .srt/.vtt/.ass file when track is null) to WebVTT. */
export function subtitleToVtt (input: string, track: number | null, { ffmpegPath = 'ffmpeg' }: ToolOptions = {}): Promise<string> {
  const map = track === null ? ['-map', '0:s:0'] : ['-map', `0:s:${track}`]
  const args = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-i', input, ...map, '-c:s', 'webvtt', '-f', 'webvtt', 'pipe:1']
  return new Promise((resolve, reject) => {
    execFile(ffmpegPath, args, { timeout: 600_000, maxBuffer: 32 * 1024 ** 2 }, (err, stdout, stderr) =>
      err ? reject(new MediaToolError(`Subtitle conversion failed: ${lastLine(stderr) || err.message}`)) : resolve(stdout))
  })
}

/** Settings read per job, so a saved change applies to the next one. */
export interface MediaLive {
  ffprobePath: string
  ffmpegPath: string
  maxProbes: number
  maxSubtitleJobs: number
}

export interface MediaTools {
  /** probe(), bounded and cached per input; a failed probe is forgotten so the next call retries. */
  probe: (input: string, fileName: string, context?: OperationContext) => Promise<MediaInfo>
  /**
   * The file's keyframe times from its own index (keyframeIndex()), cached per input like probes; null when it has
   * none or it couldn't be read (a read failure is forgotten so the next call retries).
   */
  keyframes: (input: string, size: number, context?: OperationContext) => Promise<number[] | null>
  /** subtitleToVtt(), bounded. */
  subtitleToVtt: (input: string, track: number | null) => Promise<string>
  /** Busy slots and cached probe results, for the Debug page. */
  stats: () => { probes: { used: number, limit: number }, subtitles: { used: number, limit: number }, probeCache: { used: number, limit: number } }
}

/** Probe results kept, most recently used first; a file's streams don't change, so only the count is bounded. */
export const PROBE_CACHE_LIMIT = 256

/** Range reads of an HTTP input (the app's /raw URL) for keyframeIndex(). */
export function httpRanges (input: string, signal?: AbortSignal): ReadRange {
  return async (start, end) => {
    const res = await fetch(input, { headers: { Range: `bytes=${start}-${end - 1}` }, ...(signal && { signal }) })
    if (res.status !== 206 && res.status !== 200) throw new MediaToolError(`Reading the file failed: HTTP ${res.status}`)
    const bytes = new Uint8Array(await res.arrayBuffer())
    return res.status === 200 ? bytes.subarray(start, end) : bytes
  }
}

/** Probing and subtitle conversion with process limits; overload fails fast with PlaybackBusyError. */
export function createMediaTools ({ live, probeCacheLimit = PROBE_CACHE_LIMIT, logger = noopLogger, metrics = noopMetrics, readRanges = httpRanges }: { live: () => MediaLive, probeCacheLimit?: number, logger?: Logger, metrics?: Metrics, readRanges?: (input: string, signal?: AbortSignal) => ReadRange }): MediaTools {
  const runProbe = createLimiter(() => live().maxProbes, () => { metrics.reject('probe', 'capacity'); logger.warn('resource.rejected', { resource: 'probe', reason: 'capacity' }); return new PlaybackBusyError('Media probing is busy. Try again shortly.') })
  const runSubtitle = createLimiter(() => live().maxSubtitleJobs, () => { metrics.reject('subtitle', 'capacity'); logger.warn('resource.rejected', { resource: 'subtitle', reason: 'capacity' }); return new PlaybackBusyError('Subtitle conversion is busy. Try again shortly.') })
  const probes = new Map<string, Promise<MediaInfo>>()
  const ids = new Map<string, string>()
  const indexes = new Map<string, Promise<number[] | null>>()
  return {
    probe (input, fileName, context) {
      let p = probes.get(input)
      if (p) {
        context?.logger.info('probe.cache.joined', { jobId: ids.get(input) })
        probes.delete(input) // move to the most recently used end
      } else {
        const jobId = randomUUID()
        ids.set(input, jobId)
        p = observeJob(logger, metrics, 'probe', async () => await runProbe(() => probe(input, fileName, live())), { jobId }, context)
        const job = p
        job.catch(() => { if (probes.get(input) === job) { probes.delete(input); ids.delete(input) } })
      }
      probes.set(input, p)
      if (probes.size > probeCacheLimit) {
        const oldest = probes.keys().next().value!
        probes.delete(oldest); ids.delete(oldest)
      }
      return p
    },
    keyframes (input, size, context) {
      let p = indexes.get(input)
      if (p) indexes.delete(input) // move to the most recently used end
      else {
        const started = performance.now()
        p = keyframeIndex(readRanges(input, AbortSignal.timeout(120_000)), size).then(times => {
          context?.logger.info('keyframes.indexed', { keyframes: times?.length ?? 0, durationMs: performance.now() - started })
          return times
        }, (err: unknown) => {
          (context?.logger ?? logger).warn('keyframes.failed', { err })
          indexes.delete(input)
          return null
        })
      }
      indexes.set(input, p)
      if (indexes.size > probeCacheLimit) indexes.delete(indexes.keys().next().value!)
      return p
    },
    subtitleToVtt: (input, track) => observeJob(logger, metrics, 'subtitle', async () => await runSubtitle(() => subtitleToVtt(input, track, live()))),
    stats: () => ({ probes: runProbe.stats(), subtitles: runSubtitle.stats(), probeCache: { used: probes.size, limit: probeCacheLimit } }),
  }
}
