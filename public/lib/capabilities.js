// Keep these probes aligned with the server's codec keys. These are support
// hints, not guarantees about a file's profile, bit depth or hardware decoding.
const TYPES = {
  h264: 'video/mp4; codecs="avc1.640028"',
  hevc: 'video/mp4; codecs="hvc1.1.6.L120.90"',
  vp9: 'video/webm; codecs="vp9"',
  av1: 'video/mp4; codecs="av01.0.08M.08"',
  aac: 'audio/mp4; codecs="mp4a.40.2"',
  ac3: 'audio/mp4; codecs="ac-3"',
  eac3: 'audio/mp4; codecs="ec-3"',
  opus: 'audio/webm; codecs="opus"',
  flac: 'audio/mp4; codecs="flac"',
}

/**
 * Measure the same MSE/native support hints used by the player. The caller owns
 * the video element and browser objects; importing this module reads no globals.
 * ManagedMediaSource keeps its existing precedence over MediaSource. Native
 * fallback requires "probably", not "maybe". No user-agent or codec policy here.
 *
 * @param {{canPlayType: (type: string) => string}} video
 * @param {{ManagedMediaSource?: {isTypeSupported?: (type: string) => boolean}, MediaSource?: {isTypeSupported?: (type: string) => boolean}}} [browser]
 * @returns {import('./api-types.js').BrowserCapabilities}
 */
export function measureCaps (video, { ManagedMediaSource, MediaSource } = {}) {
  const MS = ManagedMediaSource || MediaSource
  return /** @type {import('./api-types.js').BrowserCapabilities} */ (Object.fromEntries(
    Object.entries(TYPES).map(([key, type]) =>
      [key, !!(MS?.isTypeSupported?.(type) || video.canPlayType(type) === 'probably')]),
  ))
}
