// Where an HLS stream's segments start, on the file's own timeline. The browser gets the whole list as a VOD
// playlist up front, so every ffmpeg run must cut the same segments wherever it starts: copied video is cut on
// keyframes from the file's index, transcoded video on keyframes ffmpeg forces at fixed times.

/** Target segment length in seconds. Copied video makes longer segments where keyframes are further apart. */
export const SEGMENT_SECONDS = 6
/** Times closer than this are the same instant (Matroska stores milliseconds; tfdt rounds to the track timescale). */
export const TIME_TOLERANCE = 0.02
/**
 * ffmpeg's CLI moves an input seek about 0.13 s earlier when the video has B-frames and the format doesn't seek by
 * PTS. Seeking this far past a keyframe still lands on that keyframe.
 */
const SEEK_MARGIN = 0.15
/** Don't start a last segment shorter than this; the previous one takes its time. */
const MIN_LAST_SEGMENT = 1

export interface SegmentPlan {
  /** Segment start times; the first is 0, so the playlist covers the whole file. */
  starts: number[]
  /** The file's duration: where the last segment ends. */
  duration: number
  /** Keyframe times the plan was cut from, for warm-up seeks; empty for a fixed plan. */
  keyframes: number[]
  /** Where a run from the beginning starts: the file's start time when that is positive, else 0. */
  origin: number
}

/** Segments for copied video: each starts on a keyframe from the index and lasts at least SEGMENT_SECONDS. */
export function keyframePlan (keyframes: readonly number[], duration: number, startTime: number): SegmentPlan {
  const starts = [0]
  let last = 0
  for (const t of keyframes) {
    if (t - last >= SEGMENT_SECONDS && duration - t >= MIN_LAST_SEGMENT) {
      starts.push(t)
      last = t
    }
  }
  return { starts, duration, keyframes: [...keyframes], origin: Math.max(0, startTime) }
}

/** Segments for transcoded video: every SEGMENT_SECONDS from where a run from the beginning starts. */
export function fixedPlan (duration: number, startTime: number): SegmentPlan {
  const origin = Math.max(0, startTime)
  const starts = [0]
  for (let t = origin + SEGMENT_SECONDS; duration - t >= MIN_LAST_SEGMENT; t += SEGMENT_SECONDS) starts.push(t)
  return { starts, duration, keyframes: [], origin }
}

/** The segment holding time `t` (clamped to the first and last). */
export function segmentAt (starts: readonly number[], t: number): number {
  let lo = 0
  let hi = starts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if ((starts[mid] ?? 0) <= t + TIME_TOLERANCE) lo = mid
    else hi = mid - 1
  }
  return lo
}

/**
 * Where an ffmpeg run producing segment `k` seeks. Copied video starts one indexed keyframe early: the audio
 * for a segment's first moments is stored before its keyframe, so a run starting exactly there leaves a hole.
 * That warm-up output is dropped. Transcoded video starts exactly on the boundary.
 */
export function runStart (plan: SegmentPlan, k: number): number {
  const start = plan.starts[k] ?? 0
  if (k <= 0 || start <= plan.origin) return plan.origin
  if (!plan.keyframes.length) return start
  let previous: number | null = null
  for (const t of plan.keyframes) {
    if (t >= start - TIME_TOLERANCE) break
    previous = t
  }
  return previous === null || previous <= plan.origin ? plan.origin : previous + SEEK_MARGIN
}

export interface PlaylistOptions {
  starts: readonly number[]
  /** Where the last listed segment ends. */
  end: number
  /** VOD: the whole file is listed. Otherwise an EVENT playlist that grows, ended once conversion finished. */
  vod: boolean
  ended: boolean
}

/** The media playlist: an fMP4 init section and seg_<n>.m4s entries. */
export function renderPlaylist ({ starts, end, vod, ended }: PlaylistOptions): string {
  const durations = starts.map((t, i) => Math.max(0, (starts[i + 1] ?? end) - t))
  const target = Math.max(1, Math.ceil(Math.max(0, ...durations)))
  return [
    '#EXTM3U',
    '#EXT-X-VERSION:7',
    `#EXT-X-TARGETDURATION:${target}`,
    '#EXT-X-MEDIA-SEQUENCE:0',
    `#EXT-X-PLAYLIST-TYPE:${vod ? 'VOD' : 'EVENT'}`,
    '#EXT-X-INDEPENDENT-SEGMENTS',
    '#EXT-X-MAP:URI="init.mp4"',
    ...durations.flatMap((d, i) => [`#EXTINF:${d.toFixed(6)},`, `seg_${i}.m4s`]),
    ...(vod || ended ? ['#EXT-X-ENDLIST'] : []),
    '',
  ].join('\n')
}
