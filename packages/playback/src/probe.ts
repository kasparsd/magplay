// What a file holds, read from its headers in Node with Mediabunny's demuxers: no ffprobe. Inputs are URLs (the app's
// /raw loopback URL, read with Range requests) or local paths (tests).
import fs from 'node:fs/promises'
import { ALL_FORMATS, EncodedPacketSink, FilePathSource, Input, MATROSKA, MP4, MPEG_TS, QTFF, UrlSource, WEBM } from 'mediabunny'
import type { InputAudioTrack, InputTrack, InputVideoTrack, Source } from 'mediabunny'
import type { AudioTrack, ProbeResult, SubtitleTrack, VideoTrack } from '@magplay/api-contract'
import { MediaToolError } from './errors.ts'
import { matroskaSubtitles } from './matroska-tracks.ts'
import type { RangeReader } from './matroska-tracks.ts'

/** A file's summary, as the player API sends it (without the torrent's external subtitles). */
export type MediaInfo = Omit<ProbeResult, 'externalSubtitles'>

export interface ProbeOptions {
  /** Give up after this long; a torrent whose head hasn't arrived keeps Range reads waiting. */
  timeoutMs?: number
  fetchFn?: typeof fetch
}

const isUrl = (input: string): boolean => /^https?:\/\//i.test(input)

/** Headers and indexes are small; a bounded cache keeps a probe from holding media in memory. */
const CACHE_BYTES = 16 * 1024 ** 2

function openSource (input: string, fetchFn?: typeof fetch): Source {
  if (!isUrl(input)) return new FilePathSource(input)
  return new UrlSource(input, {
    maxCacheSize: CACHE_BYTES,
    // Transient failures retry briefly; a /raw that keeps failing should fail the probe, not loop forever
    getRetryDelay: attempts => attempts < 3 ? 0.5 * attempts : null,
    ...(fetchFn && { fetchFn }),
  })
}

function rangeReader (input: string, fetchFn: typeof fetch = fetch): RangeReader {
  if (!isUrl(input)) {
    return async (start, end) => {
      const handle = await fs.open(input, 'r')
      try {
        const buf = new Uint8Array(end - start)
        const { bytesRead } = await handle.read(buf, 0, buf.length, start)
        return buf.subarray(0, bytesRead)
      } finally { await handle.close() }
    }
  }
  return async (start, end) => {
    const res = await fetchFn(input, { headers: { Range: `bytes=${start}-${end - 1}` } })
    if (!res.ok) throw new MediaToolError(`Reading the file failed: HTTP ${res.status}`)
    return new Uint8Array(await res.arrayBuffer())
  }
}

/** Runs `job` against an open Input, disposing it afterwards and on timeout (which cancels pending reads). */
async function withInput<T> (input: string, { timeoutMs = 120_000, fetchFn }: ProbeOptions, job: (media: Input) => Promise<T>): Promise<T> {
  const media = new Input({ source: openSource(input, fetchFn), formats: ALL_FORMATS })
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new MediaToolError('Reading the file timed out waiting for data')), timeoutMs)
  })
  try {
    return await Promise.race([job(media), timeout])
  } finally {
    clearTimeout(timer)
    media.dispose()
  }
}

const VIDEO_NAMES: Readonly<Record<string, string>> = { avc: 'h264', hevc: 'hevc', vp9: 'vp9', av1: 'av1', vp8: 'vp8', prores: 'prores' }
const AUDIO_NAMES: Readonly<Record<string, string>> = { aac: 'aac', opus: 'opus', mp3: 'mp3', vorbis: 'vorbis', flac: 'flac', ac3: 'ac3', eac3: 'eac3', dts: 'dts', ulaw: 'pcm_mulaw', alaw: 'pcm_alaw' }
/** Container IDs the demuxer couldn't name: Matroska CodecIDs ("V_MPEG4/ISO/ASP") and ISOBMFF sample entries ("mp4v"). */
const INTERNAL_NAMES: Readonly<Record<string, string>> = {
  'V_MPEG4/ISO/ASP': 'mpeg4',
  'V_MPEG4/ISO/SP': 'mpeg4',
  'V_MPEG4/MS/V3': 'msmpeg4v3',
  V_MPEG2: 'mpeg2video',
  V_MPEG1: 'mpeg1video',
  'V_MS/VFW/FOURCC': 'vfw',
  V_THEORA: 'theora',
  'V_REAL/RV40': 'rv40',
  V_FFV1: 'ffv1',
  mp4v: 'mpeg4',
  xvid: 'mpeg4',
  XVID: 'mpeg4',
  DIVX: 'mpeg4',
  A_TRUEHD: 'truehd',
  A_MLP: 'mlp',
  'A_MPEG/L2': 'mp2',
  'A_MPEG/L1': 'mp1',
  A_WAVPACK4: 'wavpack',
  A_TTA1: 'tta',
  A_ALAC: 'alac',
  'A_REAL/COOK': 'cook',
}

async function codecName (track: InputTrack, names: Readonly<Record<string, string>>): Promise<string> {
  const codec = await track.getCodec()
  if (codec) return names[codec] ?? (codec.startsWith('pcm-') ? 'pcm' : codec)
  const internal = await track.getInternalCodecId()
  if (typeof internal !== 'string' || !internal) return ''
  return INTERNAL_NAMES[internal] ?? internal.replace(/^[AVS]_/, '').split('/')[0]!.toLowerCase()
}

const AVC_PROFILES: Readonly<Record<number, string>> = { 66: 'Baseline', 77: 'Main', 88: 'Extended', 100: 'High', 110: 'High 10', 122: 'High 4:2:2', 244: 'High 4:4:4 Predictive' }
const HEVC_PROFILES: Readonly<Record<number, string>> = { 1: 'Main', 2: 'Main 10', 3: 'Main Still Picture', 4: 'Rext' }
const AV1_PROFILES: Readonly<Record<number, string>> = { 0: 'Main', 1: 'High', 2: 'Professional' }

/**
 * Profile and bit depth from a WebCodecs codec string. Browsers decode 8-bit H.264 only, so the depth decides playback;
 * H.264 carries it in the profile (High 10 and up), HEVC in its profile (Main 10), VP9 and AV1 as a field.
 */
export function codecDetails (codec: string, params: string | null): { profile: string | null, bitDepth: number } {
  const parts = (params ?? '').split('.')
  const tag = parts[0] ?? ''
  if (codec === 'h264' && /^avc[1-4]$/.test(tag) && parts[1]) {
    const idc = parseInt(parts[1].slice(0, 2), 16)
    return { profile: AVC_PROFILES[idc] ?? null, bitDepth: idc === 110 || idc === 122 || idc === 244 ? 10 : 8 }
  }
  if (codec === 'hevc' && /^(hvc1|hev1)$/.test(tag) && parts[1]) {
    const idc = parseInt(parts[1].replace(/^[ABC]/, ''), 10)
    return { profile: HEVC_PROFILES[idc] ?? null, bitDepth: idc === 2 ? 10 : idc >= 4 ? 10 : 8 }
  }
  if (codec === 'vp9' && tag === 'vp09') {
    return { profile: parts[1] ? `Profile ${Number(parts[1])}` : null, bitDepth: Number(parts[3]) || 8 }
  }
  if (codec === 'av1' && tag === 'av01') {
    return { profile: parts[1] ? AV1_PROFILES[Number(parts[1])] ?? null : null, bitDepth: Number(parts[3]) || 8 }
  }
  return { profile: null, bitDepth: 8 }
}

const language = (code: string): string | null => code && code !== 'und' ? code : null

async function videoTrack (track: InputVideoTrack): Promise<VideoTrack> {
  const codec = await codecName(track, VIDEO_NAMES)
  const [params, internal] = await Promise.all([track.getCodecParameterString(), track.getInternalCodecId()])
  const width = track.codedWidth
  const height = track.codedHeight
  // Mediabunny gives the display size for square pixels; the ratio of the two is the sample aspect
  const sampleAspect = width > 0 && height > 0 && track.squarePixelWidth > 0 && track.squarePixelHeight > 0
    ? (track.squarePixelWidth / track.squarePixelHeight) / (width / height)
    : 1
  return {
    codec,
    tag: typeof internal === 'string' ? internal : '',
    ...codecDetails(codec, params),
    width,
    height,
    sampleAspect: Math.abs(sampleAspect - 1) < 0.001 ? 1 : sampleAspect,
  }
}

async function audioTrack (track: InputAudioTrack, index: number): Promise<AudioTrack> {
  const [codec, lang, title, disposition] = await Promise.all([codecName(track, AUDIO_NAMES), track.getLanguageCode(), track.getName(), track.getDisposition()])
  return { index, codec, channels: track.numberOfChannels, language: language(lang), title, default: disposition.default }
}

/** The container as a short id: mp4, mov, matroska, webm, mpegts, or the demuxer's lower-case name. */
async function containerName (media: Input): Promise<string> {
  const format = await media.getFormat()
  if (format === MP4) return 'mp4'
  if (format === QTFF) return 'mov'
  if (format === WEBM) return 'webm'
  if (format === MATROSKA) return 'matroska'
  if (format === MPEG_TS) return 'mpegts'
  return format.name.toLowerCase().replace(/\s+/g, '-')
}

/** Summary of a file or URL (an HTTP input is read with Range requests). Unreadable inputs throw MediaToolError. */
export function probe (input: string, fileName: string, options: ProbeOptions = {}): Promise<MediaInfo> {
  return withInput(input, options, async media => {
    if (!await media.canRead().catch(() => false)) throw new MediaToolError('Unrecognized media file')
    const container = await containerName(media)
    const [duration, videoTracks, audioTracks] = await Promise.all([media.getDurationFromMetadata(), media.getVideoTracks(), media.getAudioTracks()])
    const primary = (await media.getPrimaryVideoTrack()) ?? videoTracks[0]
    const video = primary ? await videoTrack(primary) : undefined
    const audio = await Promise.all(audioTracks.map(audioTrack))
    let subtitles: SubtitleTrack[] = []
    if (container === 'matroska' || container === 'webm') {
      subtitles = await matroskaSubtitles(rangeReader(input, options.fetchFn)).catch(() => [])
    }
    return {
      duration: duration && duration > 0 ? duration : null,
      container,
      isWebm: container === 'webm' || /\.webm$/i.test(fileName),
      ...(video && { video }),
      audio,
      subtitles,
    }
  }).catch((err: unknown) => { throw err instanceof MediaToolError ? err : new MediaToolError(`Reading the file failed: ${err instanceof Error ? err.message : String(err)}`) })
}

/**
 * The video keyframe at or just before `start` seconds: copied video can only begin there. Reads the file's index;
 * falls back to `start` when the file has none or can't be read in time.
 */
export async function keyframeBefore (input: string, start: number, options: ProbeOptions = {}): Promise<number> {
  if (!(start > 0)) return 0
  try {
    return await withInput(input, { timeoutMs: 20_000, ...options }, async media => {
      const track = await media.getPrimaryVideoTrack()
      if (!track) return start
      const packet = await new EncodedPacketSink(track).getKeyPacket(start, { metadataOnly: true })
      const pts = packet?.timestamp
      return pts !== undefined && pts >= 0 && pts <= start + 0.001 ? pts : start
    })
  } catch {
    return start
  }
}
