import type { ReactNode } from 'react'
import { segments, pathData } from '../lib/sparkline.ts'
import type { SparkOptions } from '../lib/sparkline.ts'
import { SAMPLES } from '../lib/perf-samples.ts'
import type { PerfSample } from '../lib/perf-samples.ts'
import { count, formatSpeed } from '../lib/ui.ts'
function Spark ({ slots, max, layers, bands = [], refs = [] }: SparkOptions): ReactNode {
  return (
    <svg viewBox={`-0.5 0 ${slots} 100`} preserveAspectRatio='none' aria-hidden='true' className='spark'>
      {bands.flatMap((b) =>
        b.on.map(
          (on, i) =>
            on && (
              <rect
                key={`${b.className}:${i}`}
                x={slots - b.on.length + i - 0.5}
                y={0}
                width={1}
                height={100}
                className={b.className}
              />
            )
        )
      )}
      {refs.map((r) => (
        <line
          key={r.className}
          x1={-0.5}
          x2={slots - 0.5}
          y1={100 - (Math.min(r.value, max) / max) * 100}
          y2={100 - (Math.min(r.value, max) / max) * 100}
          className={r.className}
          vectorEffect='non-scaling-stroke'
        />
      ))}
      {layers.flatMap((l) =>
        segments(l.data, slots, max).map((run, i) => (
          <path
            key={`${l.kind}:${l.className}:${i}`}
            d={pathData(run, l.kind === 'area')}
            className={`${l.kind} ${l.className}`}
            vectorEffect='non-scaling-stroke'
          />
        ))
      )}
    </svg>
  )
}
function Lane ({
  name,
  value,
  sub,
  max,
  layers,
  bands,
  refs,
  note,
}: { name: string; value: string; sub: string; note?: ReactNode } & Omit<SparkOptions, 'slots'>): ReactNode {
  return (
    <div className='lane'>
      <div className='lane-label'>
        <span>{name}</span>
        <b>{value}</b>
        <small>{sub}</small>
      </div>
      <div className='lane-plot'>
        <Spark
          slots={SAMPLES}
          max={max}
          layers={layers}
          {...(bands ? { bands } : {})}
          {...(refs ? { refs } : {})}
        />
        {note}
      </div>
    </div>
  )
}
const top = (values: Array<number | null>, floor: number): number =>
  Math.max(floor, ...values.filter((v): v is number => v != null)) * 1.15
export function Performance ({
  history,
  direct,
}: {
  history: readonly PerfSample[]
  direct: boolean
}): ReactNode {
  const last = history.at(-1)
  if (!last) return <p className='muted'>Collecting samples. The graph fills in over 3 minutes.</p>
  const download = history.map((s) => s.download)
  const stalls = history.reduce((n, s, i) => n + (s.stalled && !history[i - 1]?.stalled ? 1 : 0), 0)
  const cpu = history.some((s) => s.cpu != null)
  const speeds = history.map((s) => (s.paused ? null : s.speed))
  const max = Math.min(top(speeds, 2), 4)
  const ahead = history.map((s) => s.ahead)
  const buffer = history.map((s) => s.buffer)
  const legends = [
    ['dl', 'Download'],
    ...(!direct
      ? [
          ['ff', 'ffmpeg speed'],
          ...(cpu ? [['cpu', 'ffmpeg CPU, share of all cores']] : []),
          ['paused', 'ffmpeg paused 240 s ahead'],
          ['ahead', 'Converted ahead'],
        ]
      : []),
    ['buf', 'Browser buffer'],
    ['stall', 'Stalled'],
  ]
  return (
    <>
      <div className='lanes'>
        <Lane
          name='Swarm'
          value={formatSpeed(last.download)}
          sub={count(last.peers, 'peer')}
          max={top(download, 1e6)}
          layers={[
            { data: download, kind: 'area', className: 'dl' },
            { data: download, kind: 'line', className: 'dl' },
          ]}
        />
        {!direct && (
          <Lane
            name='Transcoder'
            value={last.paused ? 'Paused' : last.speed ? `${last.speed.toFixed(1)}×` : '…'}
            sub={
              [
                last.cpu != null && `CPU ${Math.round(last.cpu * 100)}%`,
                last.fps && `${Math.round(last.fps)} fps`,
              ]
                .filter(Boolean)
                .join(' · ') || 'ffmpeg'
            }
            max={max}
            layers={[
              ...(cpu
                ? [
                    {
                      data: history.map((s) => (s.cpu == null ? null : s.cpu * max)),
                      kind: 'area' as const,
                      className: 'cpu',
                    },
                  ]
                : []),
              { data: speeds, kind: 'line', className: 'ff' },
            ]}
            bands={[{ on: history.map((s) => s.paused), className: 'paused' }]}
            refs={[{ value: 1, className: 'realtime' }]}
            note={
              <span className='ref-label' style={{ bottom: `${(1 / max) * 100}%` }}>
                1× realtime
              </span>
            }
          />
        )}
        <Lane
          name='Buffer'
          value={`${Math.round(last.buffer)} s`}
          sub={
            [
              !direct && last.ahead != null && `ffmpeg ${Math.round(last.ahead)} s ahead`,
              stalls > 0 && count(stalls, 'stall'),
            ]
              .filter(Boolean)
              .join(' · ') || 'in the browser'
          }
          max={top([...ahead, ...buffer], 30)}
          layers={[
            ...(!direct ? [{ data: ahead, kind: 'area' as const, className: 'ahead' }] : []),
            { data: buffer, kind: 'line', className: 'buf' },
          ]}
          bands={[{ on: history.map((s) => s.stalled), className: 'stall' }]}
        />
        <div className='lane axis' aria-hidden='true'>
          <span />
          <div>
            <span>3 min ago</span>
            <span>now</span>
          </div>
        </div>
      </div>
      <div className='legend'>
        {legends.map(([className, label]) => (
          <span key={className}>
            <i className={`swatch ${className}`} />
            {label}
          </span>
        ))}
      </div>
    </>
  )
}
