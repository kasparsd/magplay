import type { SettingDef } from '@magplay/api-contract'
import { field } from './fields.ts'
import { el } from './ui.ts'

export interface ControlOptions {
  value: unknown
  disabled?: boolean
  error?: string
  onChange: (value: unknown) => void
}

/** Renders schema-driven controls through the shared label/description/help field anatomy. */
export function control (def: SettingDef, { value, disabled = false, error, onChange }: ControlOptions): HTMLElement {
  const id = `setting-${def.key}`
  let input: HTMLElement
  if (def.type === 'toggle') {
    const checkbox = el('input', { id, type: 'checkbox', checked: Boolean(value), disabled })
    checkbox.setAttribute('role', 'switch')
    checkbox.addEventListener('change', () => onChange(checkbox.checked))
    input = el('span', { className: 'switch-control' }, checkbox, el('span', { ariaHidden: 'true' }))
  } else if (def.type === 'select' || def.type === 'segmented') {
    const select = el('select', { id, disabled })
    for (const option of def.options ?? []) select.append(el('option', { value: String(option.value), textContent: option.label, selected: option.value === value }))
    select.addEventListener('change', () => onChange(typeof def.default === 'number' ? Number(select.value) : select.value))
    input = select
  } else {
    const type = def.type === 'number' ? 'number' : def.type === 'secret' ? 'password' : def.type === 'url' ? 'url' : 'text'
    const text = typeof value === 'string' || typeof value === 'number' ? String(value) : ''
    const element = el('input', { id, type, value: text, disabled, min: def.min == null ? '' : String(def.min), max: def.max == null ? '' : String(def.max), step: def.step == null ? '' : String(def.step) })
    element.addEventListener('change', () => onChange(def.type === 'number' ? Number(element.value) : element.value))
    input = el('span', { className: 'field-input' }, element, def.unit && el('span', { className: 'unit', textContent: def.unit }))
  }
  return field({ id, label: def.label, description: def.help, help: def.moreHelp, error, control: input })
}
