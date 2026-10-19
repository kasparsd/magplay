import { randomUUID } from 'node:crypto'
import { noopLogger, noopMetrics, observeJob } from '@magplay/observability'
import type { Logger, Metrics, OperationContext } from '@magplay/observability'
// What a file holds (ffprobe), how this browser should play it, and the ffmpeg work behind it.
// Inputs are URLs or paths; the app passes its /raw loopback URL.
import { execFile } from 'node:child_process'
import type { ExecFileOptions } from 'node:child_process'
import type { AudioTrack, BrowserCapabilities, ProbeResult, SubtitleTrack, VideoCodecKey, VideoTrack } from '@magplay/api-contract'
import { MediaToolError, NoSuchTrackError, PlaybackBusyError, UnplayableError } from './errors.ts'
import { createLimiter } from './limits.ts'

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
  transcodeEncoder?: string
  vaapiDevice?: string
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

/**
 * The video keyframe at or just before `start` seconds: input seeking can only begin copied video there.
 * One indexed read (`-skip_frame nokey` emits that keyframe first). Falls back to `start` when the file has no index.
 */
export function keyframeBefore (input: string, start: number, { ffprobePath = 'ffprobe' }: ToolOptions = {}): Promise<number> {
  if (!(start > 0)) return Promise.resolve(0)
  const args = ['-v', 'error', '-select_streams', 'v:0', '-skip_frame', 'nokey', '-show_entries', 'frame=pts_time', '-read_intervals', `${start}%+#1`, '-of', 'csv=p=0', input]
  return new Promise(resolve => {
    execFile(ffprobePath, args, { timeout: 20_000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      const pts = Number((stdout ?? '').split(/[,\s]/, 1)[0])
      resolve(!err && pts >= 0 && pts <= start + 0.001 ? pts : start)
    })
  })
}

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

export interface FfmpegArgsOptions {
  input: string
  info: Pick<MediaInfo, 'audio' | 'subtitles'> & { video?: Pick<VideoTrack, 'codec'> | undefined }
  audio: number
  /** Seconds into the input. */
  start: number
  mode: 'remux' | 'transcode'
  /** Where the playlist, segments and WebVTT files go. */
  dir: string
  transcodeMaxHeight: number
  transcodeEncoder?: string
  vaapiDevice?: string
}

/** ffmpeg arguments for an HLS session starting at `start` seconds, plus WebVTT outputs for text subtitles. */
export const TRANSCODE_ENCODERS = ['libx264', 'h264_nvenc', 'h264_vaapi', 'h264_videotoolbox', 'h264_qsv'] as const
export type TranscodeEncoder = typeof TRANSCODE_ENCODERS[number]

export function isTranscodeEncoder (value: unknown): value is TranscodeEncoder {
  return typeof value === 'string' && (TRANSCODE_ENCODERS as readonly string[]).includes(value)
}

const PRIORITY = ['h264_nvenc', 'h264_vaapi', 'h264_videotoolbox', 'h264_qsv', 'libx264'] as const
const HARDWARE_ENCODERS = PRIORITY.filter(name => name !== 'libx264')

export function resolveTranscodeEncoder (requested: string | undefined, available: readonly string[] = []): TranscodeEncoder {
  const req = (requested ?? 'auto').trim()
  if (req && req !== 'auto') {
    if (isTranscodeEncoder(req) && (req === 'libx264' || available.includes(req))) return req
    return 'libx264'
  }
  for (const name of PRIORITY) {
    if (name === 'libx264' || available.includes(name)) return name
  }
  return 'libx264'
}

export function parseEncoders (text: string): string[] {
  const found = new Set<string>()
  for (const line of (text ?? '').split(/\r?\n/)) {
    for (const name of TRANSCODE_ENCODERS) {
      if (line.includes(name)) found.add(name)
    }
  }
  return [...found]
}
// aliases for tests
export const parseEncoderList = parseEncoders
export const detectEncodersFromOutput = parseEncoders

export type EncoderCommandRunner = (command: string, args: string[], options: ExecFileOptions) => Promise<{ stdout: string }>

export interface EncoderDetectionOptions {
  vaapiDevice?: string
  logger?: Logger
  run?: EncoderCommandRunner
}

const runEncoderCommand: EncoderCommandRunner = (command, args, options) => new Promise((resolve, reject) => {
  execFile(command, args, options, (err, stdout, stderr) => {
    if (err) {
      const detail = lastLine(String(stderr)) || err.message
      reject(new Error(detail, { cause: err }))
    } else {
      resolve({ stdout: String(stdout ?? '') })
    }
  })
})

/** Arguments for a one-frame encode that exercises the candidate's real hardware path. */
export function encoderProbeArgs (encoder: Exclude<TranscodeEncoder, 'libx264'>, vaapiDevice = '/dev/dri/renderD128'): string[] {
  const input = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-f', 'lavfi', '-i', 'nullsrc=s=16x16:d=0.1', '-frames:v', '1']
  const output = ['-f', 'null', '-']
  if (encoder === 'h264_vaapi') return [...input, '-vaapi_device', vaapiDevice, '-vf', 'format=nv12,hwupload', '-c:v', encoder, ...output]
  return [...input, '-c:v', encoder, ...output]
}

export function ffmpegArgs ({ input, info, audio, start, mode, dir, transcodeMaxHeight, transcodeEncoder, vaapiDevice }: FfmpegArgsOptions): string[] {
  const a = info.audio[audio]
  const H = transcodeMaxHeight
  const enc = resolveTranscodeEncoder(transcodeEncoder ?? 'libx264', [])
  const device = vaapiDevice || '/dev/dri/renderD128'
  const baseGop = ['-g', '48', '-keyint_min', '48', '-sc_threshold', '0']
  const scaleVf = `scale=-2:'min(${H},ih)'`
  const transcodeVideo: Record<string, string[]> = {
    libx264: ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23', '-pix_fmt', 'yuv420p', '-vf', scaleVf, ...baseGop],
    h264_nvenc: ['-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'vbr', '-cq', '23', '-pix_fmt', 'yuv420p', '-vf', `scale=-2:'min(${H},ih)',format=yuv420p`, ...baseGop],
    h264_vaapi: ['-vaapi_device', device, '-vf', `format=nv12,hwupload,scale_vaapi=w=-2:h=min(${H},ih)`, '-c:v', 'h264_vaapi', ...baseGop],
    h264_videotoolbox: ['-c:v', 'h264_videotoolbox', '-q:v', '50', '-vf', scaleVf, ...baseGop],
    h264_qsv: ['-c:v', 'h264_qsv', '-preset', 'medium', '-global_quality', '23', '-vf', scaleVf, ...baseGop],
  }
  const video = (mode === 'transcode'
    ? (transcodeVideo[enc] ?? transcodeVideo.libx264)
    // -copytb 1 keeps the container's timebase for copied video. ffmpeg 6 (Ubuntu 24.04) otherwise derives the
    // fMP4 timescale from the codec (12288 Hz for 24 fps), and rounding an MKV's millisecond timestamps into it
    // makes movenc judge a segment's opening keyframe "out of range" and drop its presentation time.
    : ['-c:v', 'copy', '-copytb', '1', ...(info.video?.codec === 'hevc' ? ['-tag:v', 'hvc1'] : [])]) as string[]
  const audioArgs = !a ? [] : a.codec === 'aac' ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-ac', '2', '-b:a', '192k']
  const subs = (info.subtitles ?? []).filter(s => s.text).flatMap(s =>
    ['-map', `0:s:${s.index}`, '-c:s', 'webvtt', '-flush_packets', '1', '-f', 'webvtt', `${dir}/sub_${s.index}.vtt`])
  return [
    '-hide_banner', '-nostdin', '-loglevel', 'warning', '-progress', 'pipe:1',
    // Input seeking lands on the keyframe before `start`, where copied video has to begin. The caller passes that
    // keyframe (keyframeBefore), and -noaccurate_seek keeps converted audio from being trimmed to a later time.
    // A transcode can start on the requested frame, so it keeps ffmpeg's accurate seek. FLV can't seek even to 0.
    ...(start ? [...(mode === 'remux' ? ['-noaccurate_seek'] : []), '-ss', String(start)] : []), '-i', input,
    '-map', '0:v:0', ...(a ? ['-map', `0:a:${audio}`] : []),
    ...video, ...audioArgs,
    '-f', 'hls', '-hls_time', '6', '-hls_list_size', '0', '-hls_playlist_type', 'event',
    '-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', 'init.mp4',
    '-hls_flags', 'independent_segments+temp_file',
    // movenc writes every track's first fragment at tfdt 0 and puts the track's real start (the audio/video gap,
    // B-frame delay, encoder priming) into an edit list. hls.js never reads edit lists and Chrome's MSE ignores
    // empty edits, so audio ran ahead of video. frag_discont without edit lists keeps the offsets in tfdt;
    // the outer hls muxer has already made the timestamps non-negative, so the fragment muxer must not shift again.
    // skip_sidx stops the DASH index, which HLS does not read, from pulling an open-GOP segment's first sample
    // back onto the previous segment's last timestamp. That rewrite drops the frame in Chrome.
    '-hls_segment_options', 'use_editlist=0:movflags=+frag_discont+skip_sidx:avoid_negative_ts=disabled',
    '-hls_segment_filename', `${dir}/seg_%05d.m4s`, `${dir}/index.m3u8`,
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
  vaapiDevice?: string
  maxProbes: number
  maxSubtitleJobs: number
}

export interface MediaTools {
  /** probe(), bounded and cached per input; a failed probe is forgotten so the next call retries. */
  probe: (input: string, fileName: string, context?: OperationContext) => Promise<MediaInfo>
  /** subtitleToVtt(), bounded. */
  subtitleToVtt: (input: string, track: number | null) => Promise<string>
  /** Detected hardware encoders for the current ffmpeg path (cached). */
  detectedEncoders: () => string[]
  /** The video keyframe at or just before `start`; `start` itself when the file can't be indexed. */
  keyframeBefore: (input: string, start: number) => Promise<number>
  /** Re-run encoder detection. */
  refreshEncoders: () => Promise<string[]>
  /** Busy slots and cached probe results, for the Debug page. */
  stats: () => { probes: { used: number, limit: number }, subtitles: { used: number, limit: number }, probeCache: { used: number, limit: number } }
}

/** Probe results kept, most recently used first; a file's streams don't change, so only the count is bounded. */
export const PROBE_CACHE_LIMIT = 256

/** Probing and subtitle conversion with process limits; overload fails fast with PlaybackBusyError. */
export function createMediaTools ({ live, probeCacheLimit = PROBE_CACHE_LIMIT, logger = noopLogger, metrics = noopMetrics }: { live: () => MediaLive, probeCacheLimit?: number, logger?: Logger, metrics?: Metrics }): MediaTools {
  const runProbe = createLimiter(() => live().maxProbes, () => { metrics.reject('probe', 'capacity'); logger.warn('resource.rejected', { resource: 'probe', reason: 'capacity' }); return new PlaybackBusyError('Media probing is busy. Try again shortly.') })
  const runSubtitle = createLimiter(() => live().maxSubtitleJobs, () => { metrics.reject('subtitle', 'capacity'); logger.warn('resource.rejected', { resource: 'subtitle', reason: 'capacity' }); return new PlaybackBusyError('Subtitle conversion is busy. Try again shortly.') })
  const probes = new Map<string, Promise<MediaInfo>>()
  const ids = new Map<string, string>()
  let encoderCache: { ffmpegPath: string, encoders: string[] } | null = null
  const refreshEncoders = async (): Promise<string[]> => {
    const { ffmpegPath, vaapiDevice } = live()
    const encoders = await detectTranscodeEncoders(ffmpegPath, { logger, ...(vaapiDevice ? { vaapiDevice } : {}) })
    encoderCache = { ffmpegPath, encoders }
    return encoders
  }
  const detectedEncoders = (): string[] => (encoderCache && encoderCache.ffmpegPath === live().ffmpegPath) ? encoderCache.encoders : []
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
    subtitleToVtt: (input, track) => observeJob(logger, metrics, 'subtitle', async () => await runSubtitle(() => subtitleToVtt(input, track, live()))),
    detectedEncoders,
    refreshEncoders,
    keyframeBefore: (input, start) => keyframeBefore(input, start, { ffprobePath: live().ffprobePath }),
    stats: () => ({ probes: runProbe.stats(), subtitles: runSubtitle.stats(), probeCache: { used: probes.size, limit: probeCacheLimit } }),
  }
}

/** Detects available transcode encoders and verifies each compiled hardware encoder with a real encode. Never throws. */
export async function detectTranscodeEncoders (ffmpegPath = 'ffmpeg', { vaapiDevice = '/dev/dri/renderD128', logger = noopLogger, run = runEncoderCommand }: EncoderDetectionOptions = {}): Promise<string[]> {
  try {
    const { stdout } = await run(ffmpegPath, ['-hide_banner', '-encoders'], { timeout: 10_000, maxBuffer: 4 * 1024 ** 2 })
    const compiled = parseEncoders(stdout)
    const hardware = HARDWARE_ENCODERS.filter(encoder => compiled.includes(encoder))
    const probes = await Promise.all(hardware.map(async encoder => {
      try {
        await run(ffmpegPath, encoderProbeArgs(encoder, vaapiDevice), { timeout: 3_000, maxBuffer: 1024 * 1024 })
        return encoder
      } catch (err) {
        logger.warn('ffmpeg.encoder.probe.failed', { encoder, err })
        return null
      }
    }))
    return compiled.filter(encoder => encoder === 'libx264' || probes.includes(encoder as typeof HARDWARE_ENCODERS[number]))
  } catch {
    return []
  }
}
export const detectAvailableEncoders = detectTranscodeEncoders
export const detectEncoders = detectTranscodeEncoders
