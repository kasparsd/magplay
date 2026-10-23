import { CODEC_KEYS } from '@magplay/api-contract'
import type { BrowserCapabilities, CodecKey } from '@magplay/api-contract'

// One MIME probe per codec key the server's playback decision reads. These are
// support hints, not guarantees about a file's profile, bit depth or hardware decoding.
const TYPES: Record<CodecKey, string> = {
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

interface TypeSupport { isTypeSupported?: (type: string) => boolean }
export interface BrowserMedia { ManagedMediaSource?: TypeSupport, MediaSource?: TypeSupport }

/**
 * Measure the same MSE/native support hints used by the player. The caller owns
 * the video element and browser objects; importing this module reads no globals.
 * ManagedMediaSource keeps its existing precedence over MediaSource. Native
 * fallback requires "probably", not "maybe". No user-agent or codec policy here.
 */
/** A page can repackage a file itself when it can append media to a source buffer. */
export const browserCanRemux = ({ ManagedMediaSource, MediaSource }: BrowserMedia = {}): boolean => !!(ManagedMediaSource || MediaSource)

export function measureCaps (video: { canPlayType: (type: string) => string }, { ManagedMediaSource, MediaSource }: BrowserMedia = {}): BrowserCapabilities {
  const MS = ManagedMediaSource || MediaSource
  return Object.fromEntries(CODEC_KEYS.map(key =>
    [key, MS?.isTypeSupported?.(TYPES[key]) || video.canPlayType(TYPES[key]) === 'probably'])) as BrowserCapabilities
}
