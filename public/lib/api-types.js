// JSDoc contracts for the existing server JSON API. Type-only imports do not
// execute this module. These describe wire data, not runtime validation or UI state.

/** @typedef {Record<'h264' | 'hevc' | 'vp9' | 'av1' | 'aac' | 'ac3' | 'eac3' | 'opus' | 'flac', boolean>} BrowserCapabilities */

/**
 * GET /api/probe/:ih/:idx. Track indexes are zero-based within each stream type,
 * not ffmpeg's absolute stream indexes. Missing video is omitted on the wire.
 * @typedef {object} ProbeResult
 * @property {number | null} duration Seconds, or unknown.
 * @property {string} container ffprobe format names, e.g. "matroska,webm".
 * @property {boolean} isWebm
 * @property {{codec: string, tag: string, profile: string | null, width: number, height: number, bitDepth: number}} [video]
 * @property {Array<{index: number, codec: string, channels: number, language: string | null, title: string | null, default: boolean}>} audio
 * @property {Array<{index: number, codec: string, language: string | null, title: string | null, text: boolean}>} subtitles
 * @property {Array<{idx: number, name: string}>} externalSubtitles Torrent file indexes, not embedded stream indexes.
 */

/**
 * POST /api/play. `start` is an absolute media timestamp in seconds; the server
 * chooses direct/remux/transcode from the probe and reported browser capabilities.
 * @typedef {object} PlayRequest
 * @property {string} ih Torrent infohash.
 * @property {number} idx Torrent file index.
 * @property {number} [audio] Audio stream index, default 0.
 * @property {number} [start] Default 0.
 * @property {string} [tab] Per-page identifier for replacing the tab's old session.
 * @property {Partial<BrowserCapabilities>} [caps]
 */

/**
 * Direct playback has no ffmpeg session or HLS subtitle URLs.
 * @typedef {object} DirectDecision
 * @property {'direct'} mode
 * @property {string} reason
 * @property {number | null} duration
 * @property {string} url Same-origin /raw URL.
 * @property {0} offset video.currentTime already refers to the whole media file.
 * @property {never} [session]
 * @property {never} [subtitles]
 */

/**
 * HLS playback uses a session-relative video timeline. Absolute media position is
 * offset + video.currentTime; embedded session subtitles use that relative timeline.
 * @typedef {object} HlsDecision
 * @property {'remux' | 'transcode'} mode
 * @property {string} reason
 * @property {number | null} duration Whole media duration, not the HLS session duration.
 * @property {string} url Same-origin /hls/:session/index.m3u8 URL.
 * @property {number} offset Absolute media start in seconds.
 * @property {string} session
 * @property {Array<{index: number, url: string}>} subtitles Embedded text-track indexes and session URLs.
 */

/** @typedef {DirectDecision | HlsDecision} PlaybackDecision POST /api/play success. Client-only `complete` is not part of this response. */

/**
 * ffmpeg session snapshot included by GET /api/torrents/:ih/status.
 * @typedef {object} SessionStats
 * @property {string} id
 * @property {'remux' | 'transcode'} mode
 * @property {number | null} speed Conversion speed relative to real time.
 * @property {number} produced Seconds generated relative to this session's start.
 * @property {boolean} paused Paused ahead of playback, not the video's play/pause state.
 * @property {boolean} running
 * @property {boolean} failed Finished unsuccessfully; !running alone does not mean failure.
 * @property {string | null} error
 */

/**
 * @typedef {object} PeerStats
 * @property {string | null} address
 * @property {string | null} client
 * @property {string} [type]
 * @property {number} downloadSpeed Bytes per second.
 * @property {number} uploadSpeed Bytes per second.
 * @property {number} downloaded Bytes.
 * @property {number} uploaded Bytes.
 * @property {number} share Fraction of pieces the peer has.
 * @property {boolean} choking
 */

/**
 * GET /api/torrents/:ih/status. Unloaded responses omit torrent statistics.
 * `idx` adds file ranges and keeps the torrent active; `session` and session-relative
 * `pos` keep ffmpeg alive and drive its ahead-of-playback throttle. Polling must not
 * be cached or automatically retried by the transport.
 * @typedef {{loaded: false, session: SessionStats | null} | {
 *   loaded: true,
 *   activeStreams: number,
 *   session: SessionStats | null,
 *   downloadSpeed: number,
 *   uploadSpeed: number,
 *   downloaded: number,
 *   length: number,
 *   progress: number,
 *   files: Array<{idx: number, progress: number}>,
 *   peers: PeerStats[],
 *   file?: {idx: number, progress: number, ranges: Array<[number, number]>}
 * }} TorrentStatus
 */

export {}
