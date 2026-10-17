import { el } from './ui.ts'

export interface FieldOptions {
  id: string
  label: string
  description?: string | undefined
  help?: string | undefined
  error?: string | undefined
  control: HTMLElement
}

/** Shared field anatomy: label, visible description, optional expandable help and validation. */
export function field ({ id, label, description, help, error, control }: FieldOptions): HTMLElement {
  return el('div', { className: `form-field${error ? ' invalid' : ''}` },
    el('label', { className: 'form-field-label', htmlFor: id, textContent: label }),
    el('div', { className: 'form-field-content' },
      control,
      description && el('p', { className: 'form-field-description', textContent: description }),
      help && el('details', { className: 'form-field-help' },
        el('summary', { textContent: '(i) More help' }),
        el('p', { textContent: help })),
      error && el('p', { className: 'field-error', textContent: error })))
}
