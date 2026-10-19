// Retained controls: changes of cause and routine telemetry updates preserve focus,
// the inspected stage, the Diagnostics disclosure, and open external-player menus.
import { el, fill } from './ui.ts'
import type { PlaybackAction } from './playback-status.ts'
import type { FlowStageId, PlaybackPresentation } from './playback-flow.ts'

const SYMBOLS = { pending: '·', working: '', waiting: '◷', ready: '✓', bypassed: '−', unknown: '?', failed: '!' }

export function playbackStatusView (root: HTMLElement, announcement: HTMLElement, action: (name: PlaybackAction) => Node | null, togglePin: () => void): (model: PlaybackPresentation | null, elapsed: number, context: string) => void {
  let latest: PlaybackPresentation | null = null
  let selected: FlowStageId | null = null
  let signature = ''
  let actionSignature = ''
  let factsSignature = ''
  const clock = el('span', { className: 'playback-elapsed' })
  const mode = el('span', { className: 'playback-mode' })
  const pin = el('button', { type: 'button', className: 'flow-pin', onclick: togglePin })
  const heading = el('h2')
  const description = el('p', { className: 'playback-description' })
  const evidence = el('p', { className: 'playback-evidence' })
  const flow = el('ol', { className: 'playback-flow', ariaLabel: 'Playback pipeline' })
  const inspectorTitle = el('strong')
  const follow = el('button', { type: 'button', className: 'flow-follow', textContent: 'Follow current wait', onclick: () => { selected = null; inspect() } })
  const metric = el('p', { className: 'flow-metric' })
  const fillBar = el('span')
  const meter = el('div', { className: 'flow-meter' }, fillBar)
  const detail = el('p', { className: 'flow-detail' })
  const inspector = el('section', { className: 'flow-inspector', ariaLabel: 'Selected playback stage' },
    el('div', { className: 'flow-inspector-head' }, inspectorTitle, follow), metric, meter, detail)
  const actions = el('div', { className: 'actions' })
  const facts = el('dl', { className: 'playback-facts' })
  const inspectedLabel = el('dt')
  const inspectedDetail = el('dd')
  const diagnostics = el('details', { className: 'playback-why' }, el('summary', { textContent: 'Diagnostics' }), facts)
  const nodes = (['torrent', 'server', 'prepare', 'player'] as const).map(id => {
    const symbol = el('span', { className: 'flow-symbol', ariaHidden: 'true' })
    const label = el('span', { className: 'flow-label', textContent: { torrent: 'Torrent', server: 'Server', prepare: 'Prepare', player: 'Player' }[id] })
    const state = el('span', { className: 'flow-state' })
    const transfer = el('span', { className: 'flow-transfer', ariaHidden: 'true' })
    const button = el('button', { type: 'button', className: 'flow-node', onclick: () => { selected = id; inspect() } }, symbol, label, state)
    const item = el('li', {}, button, transfer)
    item.dataset.stage = id
    flow.append(item)
    return { id, item, button, symbol, state, transfer }
  })
  fill(root, el('div', { className: 'playback-reason' },
    el('div', { className: 'flow-toolbar' }, clock, mode, pin),
    el('div', { className: 'flow-heading' }, heading, description), evidence, flow, inspector,
    el('div', { className: 'flow-footer' }, actions, diagnostics)))

  function inspect (): void {
    if (!latest) return
    const focused = selected ?? latest.flow.focus ?? 'player'
    const stage = latest.flow.stages.find(stage => stage.id === focused)
    if (!stage) return
    for (const node of nodes) node.button.setAttribute('aria-pressed', String(node.id === focused))
    inspector.dataset.stage = focused
    inspector.dataset.state = stage.state
    inspectorTitle.textContent = `${stage.name} · ${stage.label}`
    follow.textContent = selected ? 'Follow current wait' : 'Following current wait'
    follow.setAttribute('aria-pressed', String(selected === null))
    metric.textContent = stage.metric
    detail.textContent = stage.detail
    inspectedLabel.textContent = `${stage.name} details`
    inspectedDetail.textContent = `${stage.metric}. ${stage.detail}`
    const measured = stage.progress != null
    const active = stage.state === 'working' || stage.state === 'waiting'
    meter.style.visibility = measured || active ? 'visible' : 'hidden'
    meter.classList.toggle('indeterminate', !measured)
    meter.setAttribute('role', 'progressbar')
    meter.setAttribute('aria-label', measured ? 'Selected file source bytes on server' : `${stage.name}: completion unknown`)
    meter.setAttribute('aria-valuemin', '0')
    meter.setAttribute('aria-valuemax', '100')
    if (measured) {
      // Rounded 100% is never displayed until the selected file is exactly complete.
      const percent = stage.progress === 1 ? 100 : Math.min(99, Math.floor((stage.progress ?? 0) * 100))
      meter.setAttribute('aria-valuenow', String(percent))
      fillBar.style.width = `${percent}%`
    } else {
      meter.removeAttribute('aria-valuenow')
      fillBar.style.width = '100%'
    }
    meter.setAttribute('aria-hidden', String(!measured && !active))
  }

  return (model, elapsed, context) => {
    latest = model
    root.hidden = !model
    if (!model) { signature = ''; announcement.textContent = ''; return }
    const brief = model.key === 'brief' && !model.pinned
    const compact = model.kind === 'warning' && !model.pinned
    root.className = `playback-status ${model.kind}${brief ? ' brief' : ''}${model.pinned ? ' pinned' : ''}`
    root.dataset.reason = model.key
    root.dataset.wait = model.flow.focus ?? 'unknown'
    root.dataset.pinned = String(model.pinned)
    heading.textContent = model.title
    description.textContent = model.kind === 'error' ? 'See Diagnostics for the reported error and available recovery options.' : model.description
    evidence.textContent = model.evidence.join(' · ')
    mode.textContent = model.flow.mode
    pin.textContent = model.pinned ? model.kind === 'debug' ? 'Hide flow' : 'Unpin flow' : 'Pin flow'
    pin.setAttribute('aria-pressed', String(model.pinned))
    clock.textContent = model.kind === 'warning' ? 'Playback advisory' : model.kind === 'error' ? 'Playback stopped' : model.kind === 'debug' ? model.key === 'paused' ? 'Paused' : 'Playing' : context || `Waiting ${Math.floor(elapsed / 1000)} s`
    clock.title = clock.textContent
    for (const node of nodes) {
      const stage = model.flow.stages.find(stage => stage.id === node.id)
      if (!stage) continue
      node.item.dataset.state = stage.state
      node.item.dataset.wait = String(node.id === model.flow.focus)
      node.symbol.textContent = SYMBOLS[stage.state]
      node.state.textContent = stage.label
      node.transfer.textContent = stage.transfer
      node.button.setAttribute('aria-label', `${stage.name}: ${stage.label}. Inspect stage`)
    }
    inspect()
    inspector.hidden = flow.hidden = brief || compact
    diagnostics.hidden = pin.hidden = brief || compact
    const nextActions = JSON.stringify(model.actions)
    if (actionSignature !== nextActions) {
      actionSignature = nextActions
      // Keep common actions attached: an open external-player menu survives a
      // change from browser buffering to an attributable conversion failure.
      const wanted = new Set(model.actions)
      for (const child of Array.from(actions.children)) {
        if (!wanted.has(child.getAttribute('data-action') as PlaybackAction)) child.remove()
      }
      for (const [index, name] of model.actions.entries()) {
        if (actions.querySelector(`[data-action="${name}"]`)) continue
        const node = action(name)
        if (node instanceof HTMLElement) {
          node.dataset.action = name
          const following = model.actions.slice(index + 1).map(name => actions.querySelector(`[data-action="${name}"]`)).find(Boolean) ?? null
          actions.insertBefore(node, following)
        }
      }
    }
    const nextFacts = JSON.stringify(model.facts)
    if (factsSignature !== nextFacts) {
      factsSignature = nextFacts
      const rows: Array<[string, string]> = [...model.facts,
        ['Explanation', model.description],
        ['Download rate scope', 'Entire torrent; not selected-file throughput'],
        ['Media delivery', 'Server-to-browser rate is not measured'],
        ['Readiness', 'A check means ready for playback, not processing finished'],
      ]
      fill(facts, ...rows.flatMap(([label, value]) => [el('dt', { textContent: label }), el('dd', { textContent: value })]))
      facts.append(inspectedLabel, inspectedDetail)
    }
    const next = JSON.stringify([model.key, model.title, model.description])
    if (signature !== next) {
      signature = next
      announcement.setAttribute('role', model.kind === 'error' ? 'alert' : 'status')
      announcement.setAttribute('aria-live', model.kind === 'error' ? 'assertive' : 'polite')
      announcement.textContent = model.kind === 'debug' ? '' : `${model.title}. ${model.description}`
    }
  }
}
