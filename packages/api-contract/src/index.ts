// Wire contracts for the server JSON API, shared by apps/server (handlers) and
// apps/client (pages). Mostly types; the settings schema and its validate() and the
// status level helpers also run, on both sides, so they stay free of Node and DOM APIs.

export * from './settings.ts'
export * from './status.ts'
export type * from './search.ts'
export type * from './explore.ts'

/** Codecs the browser reports support for and the server's playback decision reads, in one list for both sides. */
export const VIDEO_CODEC_KEYS = ['h264', 'hevc', 'vp9', 'av1'] as const
export const AUDIO_CODEC_KEYS = ['aac', 'ac3', 'eac3', 'opus', 'flac'] as const
export const CODEC_KEYS = [...VIDEO_CODEC_KEYS, ...AUDIO_CODEC_KEYS] as const
export type VideoCodecKey = typeof VIDEO_CODEC_KEYS[number]
export type AudioCodecKey = typeof AUDIO_CODEC_KEYS[number]
export type CodecKey = typeof CODEC_KEYS[number]

export type BrowserCapabilities = Record<CodecKey, boolean>

export interface VideoTrack {
  codec: string
  tag: string
  profile: string | null
  /** Coded size in pixels. */
  width: number
  height: number
  /** Pixel (sample) aspect ratio, 1 for square pixels. Display aspect is width × sampleAspect / height. */
  sampleAspect: number
  bitDepth: number
}

export interface AudioTrack {
  index: number
  codec: string
  channels: number
  language: string | null
  title: string | null
  default: boolean
}

export interface SubtitleTrack {
  index: number
  codec: string
  language: string | null
  title: string | null
  text: boolean
}

/**
 * GET /api/probe/:ih/:idx. Track indexes are zero-based within each stream type,
 * not ffmpeg's absolute stream indexes. Missing video is omitted on the wire.
 */
export interface ProbeResult {
  /** Seconds, or unknown. */
  duration: number | null
  /** ffprobe format names, e.g. "matroska,webm". */
  container: string
  isWebm: boolean
  video?: VideoTrack
  audio: AudioTrack[]
  subtitles: SubtitleTrack[]
  /** Torrent file indexes, not embedded stream indexes. */
  externalSubtitles: Array<{ idx: number, name: string }>
}

/**
 * POST /api/play. `start` is an absolute media timestamp in seconds; the server
 * chooses direct/remux/transcode from the probe and reported browser capabilities.
 */
export interface PlayRequest {
  /** Torrent infohash. */
  ih: string
  /** Torrent file index. */
  idx: number
  /** Audio stream index, default 0. */
  audio?: number
  /** Default 0. */
  start?: number
  /** Per-page identifier for replacing the tab's old session. */
  tab?: string
  caps?: Partial<BrowserCapabilities>
}

/** Direct playback has no ffmpeg session or HLS subtitle URLs. */
export interface DirectDecision {
  mode: 'direct'
  reason: string
  duration: number | null
  /** Same-origin /raw URL. */
  url: string
  /** video.currentTime already refers to the whole media file. */
  offset: 0
  session?: never
  subtitles?: never
}

/**
 * HLS playback uses a session-relative video timeline. Absolute media position is
 * offset + video.currentTime; embedded session subtitles use that relative timeline.
 */
export interface HlsDecision {
  mode: 'remux' | 'transcode'
  reason: string
  /** Whole media duration, not the HLS session duration. */
  duration: number | null
  /** Same-origin /hls/:session/index.m3u8 URL. */
  url: string
  /** Absolute media start in seconds. */
  offset: number
  session: string
  /** Embedded text-track indexes and session URLs. */
  subtitles: Array<{ index: number, url: string }>
}

/** POST /api/play success. Client-only `complete` is not part of this response. */
export type PlaybackDecision = DirectDecision | HlsDecision

/** ffmpeg session snapshot included by GET /api/torrents/:ih/status. */
export interface SessionStats {
  id: string
  mode: 'remux' | 'transcode'
  /** Conversion speed relative to real time. */
  speed: number | null
  /** Frames per second ffmpeg is producing, from its -progress output. */
  fps: number | null
  /** ffmpeg's share of all CPU cores since the previous poll (0–1, 1 saturates the NAS), or null where it can't be measured. */
  cpu: number | null
  /** Seconds generated relative to this session's start. */
  produced: number
  /** Paused ahead of playback, not the video's play/pause state. */
  paused: boolean
  running: boolean
  /** Finished unsuccessfully; !running alone does not mean failure. */
  failed: boolean
  error: string | null
}

export interface PeerStats {
  address: string | null
  client: string | null
  type?: string
  /** Bytes per second. */
  downloadSpeed: number
  /** Bytes per second. */
  uploadSpeed: number
  /** Bytes. */
  downloaded: number
  /** Bytes. */
  uploaded: number
  /** Fraction of pieces the peer has. */
  share: number
  choking: boolean
}

/**
 * GET /api/torrents/:ih/status. Unloaded responses omit torrent statistics.
 * `idx` adds file ranges and keeps the torrent active; `session` and session-relative
 * `pos` keep ffmpeg alive and drive its ahead-of-playback throttle. Polling must not
 * be cached or automatically retried by the transport.
 */
export type TorrentStatus = {
  loaded: false
  session: SessionStats | null
} | {
  loaded: true
  activeStreams: number
  session: SessionStats | null
  downloadSpeed: number
  uploadSpeed: number
  downloaded: number
  length: number
  progress: number
  files: Array<{ idx: number, progress: number }>
  peers: PeerStats[]
  file?: { idx: number, progress: number, ranges: Array<[number, number]> }
}
