// Small time-series charts as inline SVG: areas, lines, shaded spans and dashed reference lines,
// coloured by CSS classes so they follow the theme tokens. The x axis is a fixed number of slots
// with the newest value on the right, so a chart that is still filling grows from the right edge.

/** One series; null values leave a gap. */
export interface SparkLayer {
  data: ReadonlyArray<number | null>
  kind: 'area' | 'line'
  className: string
}

export interface SparkOptions {
  /** Number of x positions (samples kept); data shorter than this is right-aligned. */
  slots: number
  /** The value drawn at the top edge; larger values are clipped. */
  max: number
  layers: SparkLayer[]
  /** Shaded vertical spans where `on[i]` is true, behind the layers. */
  bands?: Array<{ on: readonly boolean[], className: string }>
  /** Dashed horizontal lines, such as 1× realtime. */
  refs?: Array<{ value: number, className: string }>
}

const H = 100

/** Runs of consecutive non-null points as [x, y] pairs in the 0..slots-1 × 0..100 box. */
export function segments (data: ReadonlyArray<number | null>, slots: number, max: number): Array<Array<[number, number]>> {
  const start = slots - data.length
  const runs: Array<Array<[number, number]>> = []
  let run: Array<[number, number]> | null = null
  data.forEach((v, i) => {
    if (v == null || !Number.isFinite(v)) { run = null; return }
    if (!run) runs.push(run = [])
    run.push([start + i, +(H - Math.max(0, Math.min(v, max)) / max * H).toFixed(2)])
  })
  return runs
}

/** SVG path data for a line, or for an area closed down to the baseline. A single point becomes a short flat step. */
export function pathData (points: Array<[number, number]>, area: boolean): string {
  const pts = points.length === 1 ? [[points[0]![0] - 0.5, points[0]![1]] as [number, number], [points[0]![0] + 0.5, points[0]![1]] as [number, number]] : points
  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x},${y}`).join(' ')
  return area ? `${line} L${pts.at(-1)![0]},${H} L${pts[0]![0]},${H} Z` : line
}
