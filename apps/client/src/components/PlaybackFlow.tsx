import { Fragment, useState } from 'react'
import type { ReactNode } from 'react'
import type { FlowStageId, PlaybackPresentation } from '../lib/playback-flow.ts'
import type { PlaybackAction } from '../lib/playback-status.ts'
const SYMBOLS = {
  pending: '·',
  working: '',
  waiting: '◷',
  ready: '✓',
  bypassed: '−',
  unknown: '?',
  failed: '!',
}
export function PlaybackFlow ({
  model,
  elapsed,
  context,
  togglePin,
  action,
}: {
  model: PlaybackPresentation | null
  elapsed: number
  context: string
  togglePin: () => void
  action: (name: PlaybackAction) => ReactNode
}): ReactNode {
  const [selected, setSelected] = useState<FlowStageId | null>(null)
  const brief = model?.key === 'brief' && !model.pinned
  const compact = model?.kind === 'warning' && !model.pinned
  const focused = selected ?? model?.flow.focus ?? 'player'
  const stage = model?.flow.stages.find((s) => s.id === focused)
  const measured = stage?.progress != null
  const active = stage?.state === 'working' || stage?.state === 'waiting'
  const percent = stage?.progress === 1 ? 100 : Math.min(99, Math.floor((stage?.progress ?? 0) * 100))
  const clock = !model
    ? ''
    : model.kind === 'warning'
      ? 'Playback advisory'
      : model.kind === 'error'
        ? 'Playback stopped'
        : model.kind === 'debug'
          ? model.key === 'paused'
            ? 'Paused'
            : 'Playing'
          : context || `Waiting ${Math.floor(elapsed / 1000)} s`
  const facts = model
    ? [
        ...model.facts,
        ['Explanation', model.description],
        ['Download rate scope', 'Entire torrent; not selected-file throughput'],
        ['Media delivery', 'Server-to-browser rate is not measured'],
        ['Readiness', 'A check means ready for playback, not processing finished'],
      ]
    : []
  return (
    <>
      <div
        id='playback-status'
        hidden={!model}
        className={`playback-status ${model?.kind ?? ''}${brief ? ' brief' : ''}${model?.pinned ? ' pinned' : ''}`}
        data-reason={model?.key}
        data-wait={model?.flow.focus ?? 'unknown'}
        data-pinned={String(model?.pinned ?? false)}
      >
        <div className='playback-reason'>
          <div className='flow-toolbar'>
            <span className='playback-elapsed' title={clock}>
              {clock}
            </span>
            <span className='playback-mode'>{model?.flow.mode}</span>
            <button
              type='button'
              className='flow-pin'
              hidden={brief || compact}
              aria-pressed={model?.pinned ?? false}
              onClick={togglePin}
            >
              {model?.pinned ? (model.kind === 'debug' ? 'Hide flow' : 'Unpin flow') : 'Pin flow'}
            </button>
          </div>
          <div className='flow-heading'>
            <h2>{model?.title}</h2>
            <p className='playback-description'>
              {model?.kind === 'error'
                ? 'See Diagnostics for the reported error and available recovery options.'
                : model?.description}
            </p>
          </div>
          <p className='playback-evidence'>{model?.evidence.join(' · ')}</p>
          <ol className='playback-flow' aria-label='Playback pipeline' hidden={brief || compact}>
            {model?.flow.stages.map((s) => (
              <li
                key={s.id}
                data-stage={s.id}
                data-state={s.state}
                data-wait={String(s.id === model.flow.focus)}
              >
                <button
                  type='button'
                  className='flow-node'
                  aria-label={`${s.name}: ${s.label}. Inspect stage`}
                  aria-pressed={s.id === focused}
                  onClick={() => setSelected(s.id)}
                >
                  <span className='flow-symbol' aria-hidden='true'>
                    {SYMBOLS[s.state]}
                  </span>
                  <span className='flow-label'>{s.name}</span>
                  <span className='flow-state'>{s.label}</span>
                </button>
                <span className='flow-transfer' aria-hidden='true'>
                  {s.transfer}
                </span>
              </li>
            ))}
          </ol>
          <section
            className='flow-inspector'
            aria-label='Selected playback stage'
            data-stage={focused}
            data-state={stage?.state}
            hidden={brief || compact}
          >
            <div className='flow-inspector-head'>
              <strong>
                {stage?.name} · {stage?.label}
              </strong>
              <button
                type='button'
                className='flow-follow'
                aria-pressed={selected === null}
                onClick={() => setSelected(null)}
              >
                {selected ? 'Follow current wait' : 'Following current wait'}
              </button>
            </div>
            <p className='flow-metric'>{stage?.metric}</p>
            <div
              className={`flow-meter${!measured ? ' indeterminate' : ''}`}
              style={{ visibility: measured || active ? 'visible' : 'hidden' }}
              role='progressbar'
              aria-label={
                measured ? 'Selected file source bytes on server' : `${stage?.name}: completion unknown`
              }
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={measured ? percent : undefined}
              aria-hidden={!measured && !active}
            >
              <span style={{ width: measured ? `${percent}%` : '100%' }} />
            </div>
            <p className='flow-detail'>{stage?.detail}</p>
          </section>
          <div className='flow-footer'>
            <div className='actions'>
              {model?.actions.map((name) => (
                <Fragment key={name}>{action(name)}</Fragment>
              ))}
            </div>
            <details className='playback-why' hidden={brief || compact}>
              <summary>Diagnostics</summary>
              <dl className='playback-facts'>
                {facts.map(([label, value]) => (
                  <Fragment key={label}>
                    <dt>{label}</dt>
                    <dd>{value}</dd>
                  </Fragment>
                ))}
                <dt>{stage?.name} details</dt>
                <dd>
                  {stage?.metric}. {stage?.detail}
                </dd>
              </dl>
            </details>
          </div>
        </div>
      </div>
      <div
        id='playback-announcement'
        className='sr-only'
        role={model?.kind === 'error' ? 'alert' : 'status'}
        aria-live={model?.kind === 'error' ? 'assertive' : 'polite'}
        aria-atomic='true'
      >
        {model && model.kind !== 'debug' ? `${model.title}. ${model.description}` : ''}
      </div>
    </>
  )
}
