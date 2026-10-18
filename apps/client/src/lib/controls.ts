// One renderer per setting type. Each returns the control for a value; the settings page wraps it in a row
// (label, help, env note, error) and decides what a change means (a draft for the server, or saved at once here).
import { isMaskedSecret } from '@magplay/api-contract'
import type { ActionDef, ChoiceDef, ItemFieldDef, ListDef, ListItem, NumberDef, SecretDef, SettingDef, TextDef } from '@magplay/api-contract'
import { languageName } from './naming.ts'
import { el } from './ui.ts'
import type { Child } from './ui.ts'

/** What a readout shows: text, text with a meter (0–1), or a ready-made node. */
export type ReadoutValue = string | Node | { text: string, fraction?: number | null }

export interface ControlContext {
  /** Element id, for the row's <label for> and deep links. */
  id: string
  /** Accessible name. */
  label: string
  disabled?: boolean
  /** `committed` is false while typing and true on change/blur, when an error may be shown. */
  onChange?: (value: unknown, committed: boolean) => void
  /** action: runs on click; a returned string is shown next to the button. */
  run?: () => Promise<string | undefined>
  /** readout: the current value. */
  readout?: () => ReadoutValue
  /** list: extra header content per item (a status badge, a Test button). */
  itemExtras?: (item: ListItem, index: number) => Child[]
  /** list: items from env vars, shown read-only first. */
  locked?: readonly ListItem[]
}

type Field = TextDef | SecretDef | NumberDef | ChoiceDef | ItemFieldDef

/** A stored value as input text: only strings and numbers are shown. */
const text = (value: unknown): string => typeof value === 'string' || typeof value === 'number' ? String(value) : ''

function textInput (def: Field & { type: 'text' | 'url' }, value: unknown, ctx: ControlContext): HTMLInputElement {
  const input = el('input', { id: ctx.id, type: def.type === 'url' ? 'url' : 'text', value: text(value), disabled: !!ctx.disabled, spellcheck: false, autocomplete: 'off' })
  input.setAttribute('aria-label', ctx.label)
  if (def.placeholder) input.placeholder = def.placeholder
  input.addEventListener('input', () => ctx.onChange?.(input.value, false))
  input.addEventListener('change', () => ctx.onChange?.(input.value, true))
  return input
}

function secretInput (def: Field & { type: 'secret' }, value: unknown, ctx: ControlContext): HTMLElement {
  const saved = isMaskedSecret(value) ? value.set : !!value
  if (ctx.disabled) return el('span', { className: 'control-note', textContent: saved ? 'Saved' : 'None' })
  const input = el('input', { id: ctx.id, type: 'password', autocomplete: 'off', placeholder: def.placeholder ?? '' })
  input.setAttribute('aria-label', ctx.label)
  input.addEventListener('input', () => ctx.onChange?.(input.value, false))
  input.addEventListener('change', () => ctx.onChange?.(input.value, true))
  if (!saved || typeof value === 'string') {
    if (typeof value === 'string') input.value = value
    return input
  }
  // Secrets never come back from the server: show that one is saved, and offer to replace it
  const replace = el('button', { type: 'button', className: 'button', textContent: 'Replace' })
  replace.setAttribute('aria-label', `Replace ${ctx.label}`)
  const box = el('span', { className: 'secret' }, el('span', { className: 'control-note', textContent: 'Saved' }), replace)
  replace.addEventListener('click', () => {
    input.placeholder = 'Paste a new key'
    box.replaceWith(input)
    input.focus()
  })
  return box
}

function numberInput (def: NumberDef, value: unknown, ctx: ControlContext): HTMLElement {
  const input = el('input', { id: ctx.id, type: 'number', value: text(value), disabled: !!ctx.disabled, inputMode: def.integer ? 'numeric' : 'decimal' })
  input.setAttribute('aria-label', def.unit ? `${ctx.label} (${def.unit})` : ctx.label)
  if (def.min !== undefined) input.min = String(def.min)
  if (def.max !== undefined) input.max = String(def.max)
  input.step = def.step !== undefined ? String(def.step) : def.integer ? '1' : 'any'
  input.addEventListener('input', () => ctx.onChange?.(input.value, false))
  input.addEventListener('change', () => ctx.onChange?.(input.value, true))
  return el('span', { className: 'number' }, input, def.unit && el('span', { className: 'unit', textContent: def.unit }))
}

function toggle (value: unknown, ctx: ControlContext): HTMLButtonElement {
  const button = el('button', { id: ctx.id, type: 'button', className: 'switch', disabled: !!ctx.disabled })
  button.setAttribute('role', 'switch')
  button.setAttribute('aria-label', ctx.label)
  const set = (on: boolean): void => button.setAttribute('aria-checked', String(on))
  set(value === true)
  button.addEventListener('click', () => {
    const on = button.getAttribute('aria-checked') !== 'true'
    set(on)
    ctx.onChange?.(on, true)
  })
  return button
}

function select (def: Pick<ChoiceDef, 'options'>, value: unknown, ctx: ControlContext): HTMLSelectElement {
  // A language the Player remembered from a file ("eng") that isn't in the list is shown as itself
  const options = typeof value === 'string' && value && !def.options.some(o => o.value === value)
    ? [{ value, label: languageName(value) }, ...def.options]
    : def.options
  const box = el('select', { id: ctx.id, disabled: !!ctx.disabled },
    ...options.map(o => el('option', { value: String(o.value), textContent: o.label, selected: o.value === value })))
  box.setAttribute('aria-label', ctx.label)
  box.addEventListener('change', () => ctx.onChange?.(options[box.selectedIndex]?.value, true))
  return box
}

function segmented (def: Pick<ChoiceDef, 'options'>, value: unknown, ctx: ControlContext): HTMLElement {
  const group = el('div', { id: ctx.id, className: 'seg' })
  group.setAttribute('role', 'radiogroup')
  group.setAttribute('aria-label', ctx.label)
  for (const o of def.options) {
    const input = el('input', { type: 'radio', name: ctx.id, value: String(o.value), checked: o.value === value, disabled: !!ctx.disabled })
    input.addEventListener('change', () => { if (input.checked) ctx.onChange?.(o.value, true) })
    group.append(el('label', {}, input, el('span', { textContent: o.label })))
  }
  return group
}

function field (def: Field, value: unknown, ctx: ControlContext): HTMLElement {
  switch (def.type) {
    case 'text':
    case 'url': return textInput(def, value, ctx)
    case 'secret': return secretInput(def, value, ctx)
    case 'number': return numberInput(def, value, ctx)
    case 'select': return select(def, value, ctx)
    case 'segmented': return segmented(def, value, ctx)
  }
}

function list (def: ListDef, value: unknown, ctx: ControlContext): HTMLElement {
  // A copy: edits must never change the saved value they're compared with
  const own = Array.isArray(value) ? [...value as ListItem[]] : []
  const box = el('div', { id: ctx.id, className: 'list' })
  const items = el('div', { className: 'list-items' })
  const title = (item: ListItem, i: number): string => (def.titleField && text(item[def.titleField])) || `${def.itemLabel[0]!.toUpperCase()}${def.itemLabel.slice(1)} ${i + 1}`
  const card = (item: ListItem, i: number, locked: boolean, update: (next: ListItem | null, committed?: boolean) => void): HTMLElement => {
    const n = `${def.itemLabel} ${i + 1}`
    const head = el('div', { className: 'list-head' },
      el('strong', { textContent: title(item, i) }),
      el('span', { className: 'list-extras' },
        ...(ctx.itemExtras?.(item, i) ?? []),
        locked
          ? el('span', { className: 'control-note', textContent: 'Set in the environment' })
          : (() => {
              const remove = el('button', { type: 'button', className: 'button', textContent: 'Remove' })
              remove.setAttribute('aria-label', `Remove ${n}`)
              remove.addEventListener('click', () => update(null))
              return remove
            })()))
    // A list of one-field items (trackers) is a list of inputs, without a card per item
    if (def.item.length === 1) {
      const [only] = def.item
      return el('div', { className: 'list-row' },
        field(only!, item[only!.key], { id: `${ctx.id}-${i}-${only!.key}`, label: `${only!.label} ${i + 1}`, disabled: locked, onChange: (v, committed) => update({ ...item, [only!.key]: v }, committed) }),
        head.lastElementChild)
    }
    // Not a disabled fieldset: that would also disable the item's Test button
    return el('fieldset', { className: `list-item${locked ? ' locked' : ''}` }, head,
      ...def.item.map(f => el('div', { className: 'row' },
        el('label', { className: 'row-label', htmlFor: `${ctx.id}-${i}-${f.key}`, textContent: f.label }),
        el('div', { className: 'row-control' }, field(f, item[f.key], {
          id: `${ctx.id}-${i}-${f.key}`,
          label: `${f.label}, ${n}`,
          disabled: locked,
          onChange: (v, committed) => update({ ...item, [f.key]: v }, committed),
        })))))
  }
  const render = (): void => {
    const lockedItems = ctx.locked ?? []
    if (!lockedItems.length && !own.length) {
      items.replaceChildren(el('p', { className: 'muted list-empty', textContent: `No ${def.itemLabel}s yet.` }))
      return
    }
    items.replaceChildren(
      ...lockedItems.map((item, i) => card(item, i, true, () => {})),
      ...own.map((item, i) => card(item, lockedItems.length + i, false, (next, committed = true) => {
        if (next) own[i] = next
        else own.splice(i, 1)
        ctx.onChange?.([...own], committed)
        if (!next) render()
      })))
  }
  render()
  const add = el('button', { type: 'button', className: 'button add', textContent: `+ Add ${def.itemLabel}` })
  add.addEventListener('click', () => {
    own.push({ id: `new-${Date.now().toString(36)}`, ...Object.fromEntries(def.item.map(f => [f.key, f.default])) })
    ctx.onChange?.([...own], false)
    render()
    items.lastElementChild?.querySelector<HTMLElement>('input, select')?.focus()
  })
  box.append(items, el('p', {}, add))
  return box
}

function action (def: ActionDef, ctx: ControlContext): HTMLElement {
  const button = el('button', { id: ctx.id, type: 'button', className: `button${def.danger ? ' danger' : ''}`, textContent: def.button })
  const result = el('span', { className: 'action-result', role: 'status' })
  let armed: ReturnType<typeof setTimeout> | null = null
  button.addEventListener('click', () => {
    if (def.confirm && !armed) {
      button.textContent = `Click again to ${def.button.toLowerCase()}`
      armed = setTimeout(() => { armed = null; button.textContent = def.button }, 4000)
      return
    }
    if (armed) clearTimeout(armed)
    armed = null
    button.textContent = def.button
    button.disabled = true
    result.className = 'action-result status busy'
    result.textContent = 'Working…'
    ;(ctx.run?.() ?? Promise.resolve(undefined)).then(message => {
      result.className = 'action-result status'
      result.textContent = message ?? 'Done'
    }, (err: unknown) => {
      result.className = 'action-result status error'
      result.textContent = err instanceof Error ? err.message : String(err)
    }).finally(() => { button.disabled = false })
  })
  return el('span', { className: 'action' }, button, result)
}

/** Renders a readout value; call again to refresh it in place. */
export function fillReadout (box: HTMLElement, value: ReadoutValue): void {
  if (typeof value === 'string' || value instanceof Node) {
    box.replaceChildren(value)
    return
  }
  const children: Node[] = [el('span', { textContent: value.text })]
  if (value.fraction != null) {
    const bar = el('span')
    bar.style.width = `${Math.round(Math.min(1, Math.max(0, value.fraction)) * 100)}%`
    children.push(el('span', { className: 'meter' }, bar))
  }
  box.replaceChildren(...children)
}

function readout (ctx: ControlContext): HTMLElement {
  const box = el('div', { id: ctx.id, className: 'readout' })
  box.setAttribute('aria-live', 'polite')
  fillReadout(box, ctx.readout?.() ?? '')
  return box
}

/** The control for one setting. */
export function renderControl (def: SettingDef, value: unknown, ctx: ControlContext): HTMLElement {
  switch (def.type) {
    case 'text':
    case 'url':
    case 'secret':
    case 'number':
    case 'select':
    case 'segmented': return field(def, value, ctx)
    case 'toggle': return toggle(value, ctx)
    case 'list': return list(def, value, ctx)
    case 'action': return action(def, ctx)
    case 'readout': return readout(ctx)
  }
}
