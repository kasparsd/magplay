import { useState } from 'react'
import type { ReactNode } from 'react'
import type { DebugInfo } from '@magplay/api-contract'
import { formatSpeed, timeAgo } from '../lib/ui.ts'
import {
  connectionLevel,
  connectionWarning,
  readConnection,
  SLOW_BYTES_PER_SEC,
  SLOW_LATENCY_MS,
} from '../lib/speedtest.ts'
import { Meter } from '../lib/controls.tsx'
const GB = 1024 ** 3
const gb = (n: number): string => `${(n / GB).toFixed(1)} GB`
const size = (n: number): string => (n < GB ? `${Math.round(n / 1024 ** 2)} MB` : gb(n))
function uptime (s: number): string {
  const d = Math.floor(s / 86400)
  const h = Math.floor(s / 3600) % 24
  const m = Math.floor(s / 60) % 60
  return d ? `${d} d ${h} h` : h ? `${h} h ${m} min` : `${m} min`
}
function InfoList ({ cells }: { cells: Array<[string, ReactNode]> }): ReactNode {
  return (
    <dl className='readout-list'>
      {cells.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  )
}
const LOG_ORDER = ['debug', 'info', 'warn', 'error'] as const
function LogView ({ debug }: { debug: DebugInfo | undefined }): ReactNode {
  const [level, setLevel] = useState<(typeof LOG_ORDER)[number]>('info')
  const lines = (debug?.log ?? [])
    .filter((l) => LOG_ORDER.indexOf(l.level) >= LOG_ORDER.indexOf(level))
    .slice(-200)
  return (
    <div>
      <p className='muted'>
        Server log level: {debug?.logging.level ?? '…'} · Dropped entries: {debug?.logging.dropped ?? 0}.
        Filter the recorded entries below.
      </p>
      <div className='seg' role='radiogroup' aria-label='Lowest log level shown'>
        {LOG_ORDER.map((l) => (
          <label key={l}>
            <input
              type='radio'
              name='log-level'
              value={l}
              checked={level === l}
              onChange={() => setLevel(l)}
            />
            <span>{l}</span>
          </label>
        ))}
      </div>
      <div className='log' tabIndex={0}>
        {lines.length
          ? (
              lines.map((l, i) => (
                <div className={`log-line lvl-${l.level}`} key={`${l.time}:${l.event}:${i}`}>
                  <time>{new Date(l.time).toLocaleTimeString([], { hour12: false })}</time>
                  <span className='log-level'>{l.level}</span>
                  <details>
                    <summary>
                      {l.msg !== l.event
                        ? l.msg
                        : l.event.replace(/[._-]+/g, ' ').replace(/^./, (c) => c.toUpperCase())}
                    </summary>
                    <pre>{JSON.stringify(l, null, 2)}</pre>
                  </details>
                </div>
              ))
            )
          : (
              <span className='muted'>{debug ? 'No log entries at this level.' : 'Loading…'}</span>
            )}
      </div>
    </div>
  )
}
export function SettingsReadout ({ name, debug }: { name: string; debug: DebugInfo | undefined }): ReactNode {
  if (name === 'connection.result') {
    const r = readConnection()
    if (!r) return 'No speed test results yet.'
    const level = connectionLevel(r)
    return (
      <div className='speed'>
        <p className='speed-numbers'>
          <strong>{formatSpeed(r.downBytesPerSec)}</strong>
          <span> download </span>
          <strong>{Math.round(r.latencyMs)} ms</strong>
          <span> latency </span>
          <span className='muted'>tested {timeAgo(r.at)}</span>
        </p>
        <p>
          <span className={`status-dot lvl-${level}`} />{' '}
          {level === 'warn'
            ? connectionWarning(r)
            : level === 'ok'
              ? `At least ${formatSpeed(SLOW_BYTES_PER_SEC)} download and no more than ${SLOW_LATENCY_MS} ms latency.`
              : 'These results are over a week old. Run the test again.'}
        </p>
      </div>
    )
  }
  if (name === 'debug.log') return <LogView debug={debug} />
  if (!debug) return 'Loading…'
  if (name === 'cache.usage') {
    return debug.disk
      ? (
          <Meter
            text={`Torrent cache: ${gb(debug.disk.cacheBytes)} / ${gb(debug.disk.cacheMaxBytes)} · Free disk space: ${gb(debug.disk.free)}`}
            fraction={debug.disk.cacheBytes / debug.disk.cacheMaxBytes}
          />
        )
      : (
          'Can’t read the cache folder.'
        )
  }
  if (name === 'debug.server') {
    return (
      <InfoList
        cells={[
          ['Version', debug.version],
          ['Uptime', uptime(debug.uptimeS)],
          ['Node', debug.node],
          ['ffmpeg', debug.ffmpeg ?? 'not installed'],
          [
            'Conversion',
            debug.serverConversion
              ? 'on the server (ffmpeg)'
              : 'in the browser when it can, otherwise in Node; nothing is re-encoded',
          ],
          ['Encoders', (debug.encoders ?? []).join(', ') || 'none'],
          ['Transcode encoder', debug.transcodeEncoder ?? 'auto'],
        ]}
      />
    )
  }
  if (name === 'debug.resources') {
    const capacity = new Set(['conversions', 'torrentLoads', 'torrents', 'probes', 'subtitles'])
    const resources = (active: boolean): ReactNode => (
      <InfoList
        cells={debug.resources
          .filter((r) => capacity.has(r.id) === active)
          .map((r) => [
            r.label,
            r.unit === 'bytes'
              ? (
                  <Meter key={r.id} text={`${size(r.used)} of ${size(r.limit)}`} fraction={r.used / r.limit} />
                )
              : r.limit
                ? (
                    <Meter key={r.id} text={`${r.used} of ${r.limit}`} fraction={r.used / r.limit} />
                  )
                : (
                    String(r.used)
                  ),
          ])}
      />
    )
    return (
      <div className='resource-groups'>
        <details id='debug-capacity'>
          <summary>Active jobs and limits</summary>
          {resources(true)}
        </details>
        <details id='debug-caches'>
          <summary>Storage and caches</summary>
          {resources(false)}
        </details>
      </div>
    )
  }
  return null
}
