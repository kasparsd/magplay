// What a jump on the Player's seek bar will do, and the seek bar's layers. Pure: the page passes in
// the decision, the browser's ranges and the file's downloaded ranges, so the tooltip and seekTo() agree.

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
  /** Absolute media time where the session starts; 0 in direct and browser-remux modes. */
  offset: number
  /** Whole media duration in seconds. */
  duration: number
  /** video.buffered, relative to the session. */
  buffered: Span[]
  /** video.seekable, relative to the session. */
  seekable: Span[]
  /** status.file.ranges: fractions of the file's bytes on the server, or null until the first status poll. */
  ranges: Array<[number, number]> | null
}

/**
 * - `buffered`: the browser has it; the jump is instant.
 * - `seekable`: the browser can land there in this session (direct mode: the bytes are on the server).
 * - `restart`: outside what the browser has, so the conversion restarts there (browser-remux and HLS modes).
 * - `missing`: not downloaded yet; playback waits for peers.
 */
export type SeekOutcome = 'buffered' | 'seekable' | 'restart' | 'missing'

/** The ranges of a TimeRanges object as [start, end] pairs. */
export function spans (ranges: RangeList): Span[] {
  return Array.from({ length: ranges.length }, (_, i): Span => [ranges.start(i), ranges.end(i)])
}

const inside = (t: number, list: Span[]): boolean => list.some(([a, b]) => t >= a && t < b)

/** Whether byte fraction `fraction` of the file is on the server. Unknown ranges count as present, so nothing warns before the first poll. */
export function onServer (fraction: number, ranges: Array<[number, number]> | null): boolean {
  return !ranges || ranges.some(([a, b]) => fraction >= a && fraction <= b)
}

/**
 * Whether session-relative time `rel` is where the browser can seek. The seekable range lags ffmpeg's
 * output (hls.js re-reads the growing playlist on its own schedule) and seeking past it clamps to
 * its edge, so stay 2 s inside the end.
 */
export function canSeekLocally (rel: number, seekable: Span[]): boolean {
  const from = seekable[0]?.[0] ?? 0
  const end = seekable.at(-1)?.[1] ?? 0
  return rel >= from - 2 && rel < end - 2
}

/** What jumping to absolute time `t` does; mirrors seekTo() in player.ts. */
export function seekOutcome (t: number, ctx: SeekContext): SeekOutcome {
  const rel = t - ctx.offset
  if (inside(rel, ctx.buffered)) return 'buffered'
  const present = onServer(ctx.duration > 0 ? t / ctx.duration : 0, ctx.ranges)
  if (ctx.mode === 'direct') return present ? 'seekable' : 'missing'
  if (ctx.mode === 'browser-remux') return present ? 'restart' : 'missing'
  if (canSeekLocally(rel, ctx.seekable)) return 'seekable'
  return present ? 'restart' : 'missing'
}

/** The tooltip's second line for an outcome, or '' when the time alone says it. */
export function seekHint (outcome: SeekOutcome): string {
  switch (outcome) {
    case 'buffered':
    case 'seekable': return ''
    case 'restart': return 'Restarts conversion here'
    case 'missing': return 'Not downloaded yet. Starts when peers send it.'
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
