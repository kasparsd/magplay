// What a jump on the Player's seek bar will do, and the seek bar's layers. Pure: the page passes in the mode, the
// browser's buffer and the server's converted and downloaded ranges. Every mode plays on the file's own timeline.

/** A time range in seconds. */
export type Span = [start: number, end: number]

/** The parts of TimeRanges that spans() reads, so tests can pass plain objects. */
export interface RangeList {
  readonly length: number
  start: (index: number) => number
  end: (index: number) => number
}

export interface SeekContext {
  mode: 'direct' | 'browser-remux' | 'remux' | 'transcode'
  /** Whole media duration in seconds. */
  duration: number
  /** video.buffered. */
  buffered: Span[]
  /** HLS: the converted time ranges from the latest status poll, or null until the first one. */
  ready: Span[] | null
  /** A growing HLS playlist (no keyframe index) ends here; null for every other file. */
  growingEnd: number | null
  /** status.file.ranges: fractions of the file's bytes on the server, or null until the first status poll. */
  ranges: Array<[number, number]> | null
}

/**
 * - `buffered`: the browser has it; the jump is instant.
 * - `seekable`: the server can send it straight away (direct mode: the bytes are on the server; HLS: it is converted).
 * - `convert`: conversion starts from there (HLS: on the server; browser-remux: in the page).
 * - `missing`: not downloaded yet; playback waits for peers.
 * - `unconverted`: past the end of a growing playlist; the seek stops at its end.
 */
export type SeekOutcome = 'buffered' | 'seekable' | 'convert' | 'missing' | 'unconverted'

/** The ranges of a TimeRanges object as [start, end] pairs. */
export function spans (ranges: RangeList): Span[] {
  return Array.from({ length: ranges.length }, (_, i): Span => [ranges.start(i), ranges.end(i)])
}

const inside = (t: number, list: Span[]): boolean => list.some(([a, b]) => t >= a && t < b)

/** Whether byte fraction `fraction` of the file is on the server. Unknown ranges count as present, so nothing warns before the first poll. */
export function onServer (fraction: number, ranges: Array<[number, number]> | null): boolean {
  return !ranges || ranges.some(([a, b]) => fraction >= a && fraction <= b)
}

/** Where a seek to `t` lands: a growing playlist can only be seeked as far as it has been converted. */
export const seekTarget = (t: number, growingEnd: number | null): number => growingEnd === null ? t : Math.min(t, Math.max(0, growingEnd - 1))

/** What jumping to time `t` does; the tooltip shows it before seekTo() does it. */
export function seekOutcome (t: number, ctx: SeekContext): SeekOutcome {
  if (inside(t, ctx.buffered)) return 'buffered'
  const hls = ctx.mode === 'remux' || ctx.mode === 'transcode'
  if (hls && ctx.growingEnd !== null && t >= ctx.growingEnd - 1) return 'unconverted'
  if (hls && ctx.ready && inside(t, ctx.ready)) return 'seekable'
  if (!onServer(ctx.duration > 0 ? t / ctx.duration : 0, ctx.ranges)) return 'missing'
  if (ctx.mode === 'browser-remux') return 'convert'
  return ctx.mode === 'direct' || !ctx.ready ? 'seekable' : 'convert'
}

/** The tooltip's second line for an outcome, or '' when the time alone says it. */
export function seekHint (outcome: SeekOutcome): string {
  switch (outcome) {
    case 'buffered':
    case 'seekable': return ''
    case 'convert': return 'Converts from here'
    case 'missing': return 'Not downloaded yet. Starts when peers send it.'
    case 'unconverted': return 'Not converted yet'
  }
}

/**
 * A CSS background that paints `fractions` (0–1 pairs) of a track in `color`, for one seek bar layer.
 * Neighbouring and overlapping ranges are merged so the gradient stays short.
 */
export function layerBackground (fractions: ReadonlyArray<readonly [number, number]>, color: string): string {
  const merged: Array<[number, number]> = []
  const clamped = fractions.map(([a, b]): [number, number] => [Math.max(0, a), Math.min(1, b)]).filter(([a, b]) => b > a)
  for (const [a, b] of clamped.sort((x, y) => x[0] - y[0])) {
    const last = merged.at(-1)
    if (last && a <= last[1] + 0.001) last[1] = Math.max(last[1], b)
    else merged.push([a, b])
  }
  if (!merged.length) return 'none'
  const pct = (n: number): string => `${+(n * 100).toFixed(3)}%`
  const stops = merged.flatMap(([a, b]) => [`transparent ${pct(a)}`, `${color} ${pct(a)}`, `${color} ${pct(b)}`, `transparent ${pct(b)}`])
  return `linear-gradient(to right, ${stops.join(', ')})`
}
