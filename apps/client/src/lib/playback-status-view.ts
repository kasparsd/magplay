// A dedicated playback channel: updates preserve focus and the Why disclosure.
import { el, fill } from './ui.ts'
import type { PlaybackAction, PlaybackExplanation } from './playback-status.ts'

export function playbackStatusView (root: HTMLElement, announcement: HTMLElement, action: (name: PlaybackAction) => Node | null): (model: PlaybackExplanation | null, elapsed: number, context: string) => void {
  let signature = ''
  let telemetry = ''
  let heading: HTMLElement
  let description: HTMLElement
  let evidence: HTMLElement
  let facts: HTMLElement
  let clock: HTMLElement
  return (model, elapsed, context) => {
    root.hidden = !model
    if (!model) { signature = ''; announcement.textContent = ''; return }
    // Include changed error text/actions even when two failures share a category.
    const next = JSON.stringify([model.key, model.title, model.description, model.actions])
    if (signature !== next) {
      signature = next
      telemetry = ''
      const brief = model.key === 'brief'
      root.className = `playback-status ${model.kind}${brief ? ' brief' : ''}`
      root.dataset.reason = model.key
      clock = el('p', { className: 'playback-elapsed' })
      heading = el('h2', { textContent: model.title })
      description = el('p', { className: 'playback-description', textContent: model.description })
      description.hidden = !model.description
      evidence = el('p', { className: 'playback-evidence' })
      facts = el('dl', { className: 'playback-facts' })
      const why = el('details', { className: 'playback-why' }, el('summary', { textContent: 'Why?' }), facts)
      why.hidden = brief || model.kind === 'warning'
      const actions = el('div', { className: 'actions' }, ...model.actions.map(action))
      const panel = el('div', { className: 'playback-reason' }, clock, heading, description, evidence, actions, why)
      fill(root, panel)
      announcement.setAttribute('role', model.kind === 'error' ? 'alert' : 'status')
      announcement.setAttribute('aria-live', model.kind === 'error' ? 'assertive' : 'polite')
      announcement.textContent = `${model.title}. ${model.description}`
    }
    const nextTelemetry = JSON.stringify([model.evidence, model.facts])
    if (telemetry !== nextTelemetry) {
      telemetry = nextTelemetry
      fill(evidence, ...model.evidence.map(text => el('span', { textContent: text })))
      evidence.hidden = model.key === 'brief' || !model.evidence.length
      fill(facts, ...model.facts.flatMap(([label, value]) => [el('dt', { textContent: label }), el('dd', { textContent: value })]))
    }
    clock.textContent = model.kind === 'warning' ? '' : model.kind === 'error' ? 'Playback stopped' : context || `Waiting ${Math.floor(elapsed / 1000)} s`
  }
}
