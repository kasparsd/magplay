// The Player's Performance disclosure: three lanes on one 3-minute axis (swarm → transcoder → buffer),
// so a stall lines up with the stage that caused it. Samples come from the page's 2 s status poll and
// live only in memory; a reload starts empty.

import { el, formatSpeed, count } from './ui.ts'
import { sparkline } from './sparkline.ts'
import type { SparkLayer } from './sparkline.ts'
import { SAMPLES } from './perf-samples.ts'
import type { PerfSample } from './perf-samples.ts'

const top = (values: Array<number | null>, floor: number): number => Math.max(floor, ...values.filter((v): v is number => v != null)) * 1.15

function lane (name: string, value: string, sub: string, layers: SparkLayer[], max: number, extra: Pick<Parameters<typeof sparkline>[0], 'bands' | 'refs'> = {}, note: Node | false = false): HTMLDivElement {
  return el('div', { className: 'lane' },
    el('div', { className: 'lane-label' }, el('span', { textContent: name }), el('b', { textContent: value }), el('small', { textContent: sub })),
    el('div', { className: 'lane-plot' }, sparkline({ slots: SAMPLES, max, layers, ...extra }), note))
}

const swatch = (className: string, text: string): HTMLSpanElement => el('span', {}, el('i', { className: `swatch ${className}` }), text)

/**
 * The lanes, axis and legend for `history`. Direct mode has no ffmpeg, so the Transcoder lane and the
 * converted-ahead area are left out; the CPU area is left out while the server can't measure CPU.
 */
export function performanceView (history: readonly PerfSample[], { direct }: { direct: boolean }): HTMLElement[] {
  const last = history.at(-1)
  if (!last) return [el('p', { className: 'muted', textContent: 'Collecting samples. The graph fills in over 3 minutes.' })]
  const download = history.map(s => s.download)
  const stalls = history.reduce((n, s, i) => n + (s.stalled && !history[i - 1]?.stalled ? 1 : 0), 0)
  const lanes = [
    lane('Swarm', formatSpeed(last.download), count(last.peers, 'peer'),
      [{ data: download, kind: 'area', className: 'dl' }, { data: download, kind: 'line', className: 'dl' }], top(download, 1e6)),
  ]
  const hasCpu = history.some(s => s.cpu != null)
  if (!direct) {
    const speeds = history.map(s => s.paused ? null : s.speed)
    // Remux runs at 50–100×; only the range around 1× matters, so the scale stops at 4× (faster is drawn at the top)
    const max = Math.min(top(speeds, 2), 4)
    const layers: SparkLayer[] = [
      ...(hasCpu ? [{ data: history.map(s => s.cpu == null ? null : s.cpu * max), kind: 'area' as const, className: 'cpu' }] : []),
      { data: speeds, kind: 'line', className: 'ff' },
    ]
    const refLabel = el('span', { className: 'ref-label', textContent: '1× realtime' })
    refLabel.style.bottom = `${(1 / max) * 100}%`
    const sub = [last.cpu != null && `CPU ${Math.round(last.cpu * 100)}%`, last.fps && `${Math.round(last.fps)} fps`].filter(Boolean).join(' · ')
    lanes.push(lane('Transcoder', last.paused ? 'Paused' : last.speed ? `${last.speed.toFixed(1)}×` : '…', sub || 'ffmpeg', layers, max,
      { bands: [{ on: history.map(s => s.paused), className: 'paused' }], refs: [{ value: 1, className: 'realtime' }] },
      refLabel))
  }
  const ahead = history.map(s => s.ahead)
  const buffer = history.map(s => s.buffer)
  const bufferLayers: SparkLayer[] = [
    ...(direct ? [] : [{ data: ahead, kind: 'area' as const, className: 'ahead' }]),
    { data: buffer, kind: 'line', className: 'buf' },
  ]
  const bufferSub = [!direct && last.ahead != null && `ffmpeg ${Math.round(last.ahead)} s ahead`, stalls > 0 && count(stalls, 'stall')].filter(Boolean).join(' · ')
  lanes.push(lane('Buffer', `${Math.round(last.buffer)} s`, bufferSub || 'in the browser', bufferLayers, top([...ahead, ...buffer], 30),
    { bands: [{ on: history.map(s => s.stalled), className: 'stall' }] }))
  const legend = [
    swatch('dl', 'Download'),
    !direct && swatch('ff', 'ffmpeg speed'),
    !direct && hasCpu && swatch('cpu', 'ffmpeg CPU, share of all cores'),
    !direct && swatch('paused', 'ffmpeg paused 240 s ahead'),
    !direct && swatch('ahead', 'Converted ahead'),
    swatch('buf', 'Browser buffer'),
    swatch('stall', 'Stalled'),
  ]
  return [
    el('div', { className: 'lanes' }, ...lanes,
      el('div', { className: 'lane axis', ariaHidden: 'true' }, el('span'), el('div', {}, el('span', { textContent: '3 min ago' }), el('span', { textContent: 'now' })))),
    el('div', { className: 'legend' }, ...legend),
  ]
}
