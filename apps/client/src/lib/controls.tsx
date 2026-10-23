// Stable React controls over the shared settings schema.
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { isMaskedSecret } from '@magplay/api-contract'
import type { ItemFieldDef, ListDef, ListItem, SettingDef } from '@magplay/api-contract'
import { presentSetting } from './setting-rules.ts'

export const text = (value: unknown): string =>
  typeof value === 'string' || typeof value === 'number' ? String(value) : ''
export const host = (value: unknown): string => {
  try {
    const url = new URL(text(value))
    return ['http:', 'https:'].includes(url.protocol) ? url.hostname : ''
  } catch {
    return ''
  }
}
export function OptionalNote ({ def }: { def: SettingDef | ItemFieldDef }): ReactNode {
  return 'optional' in def && def.optional ? <span className='optional'>(optional)</span> : null
}
export interface ControlProps {
  id: string
  label: string
  value: unknown
  disabled?: boolean
  onChange?: (value: unknown, committed: boolean) => void
}
function Secret ({
  def,
  id,
  label,
  value,
  disabled,
  onChange,
}: ControlProps & { def: SettingDef | ItemFieldDef }): ReactNode {
  const [replace, setReplace] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (replace) input.current?.focus()
  }, [replace])
  const saved = isMaskedSecret(value) ? value.set : !!value
  if (disabled && saved) return <span className='control-note'>Saved</span>
  if (!disabled && isMaskedSecret(value) && value.set && !replace) {
    return (
      <span className='secret'>
        <span className='control-note'>Saved</span>
        <button
          type='button'
          className='button'
          aria-label={`Replace ${label}`}
          onClick={() => setReplace(true)}
        >
          Replace
        </button>
      </span>
    )
  }
  return (
    <input
      ref={input}
      id={id}
      type='password'
      aria-label={label}
      autoComplete='off'
      placeholder={
        disabled ? '' : replace ? 'Paste a new key' : 'placeholder' in def ? (def.placeholder ?? '') : ''
      }
      disabled={!!disabled}
      value={text(value)}
      onChange={(e) => onChange?.(e.target.value, false)}
      onBlur={(e) => onChange?.(e.target.value, true)}
    />
  )
}
export function Field ({ def, ...props }: ControlProps & { def: SettingDef | ItemFieldDef }): ReactNode {
  const { id, label, value, disabled, onChange } = props
  switch (def.type) {
    case 'secret':
      return <Secret def={def} {...props} />
    case 'text':
    case 'url':
      return (
        <input
          id={id}
          type={def.type === 'url' ? 'url' : 'text'}
          aria-label={label}
          value={text(value)}
          disabled={!!disabled}
          spellCheck={false}
          autoComplete='off'
          placeholder={disabled ? undefined : def.placeholder}
          onChange={(e) => onChange?.(e.target.value, false)}
          onBlur={(e) => onChange?.(e.target.value, true)}
        />
      )
    case 'number':
      return (
        <span className='number'>
          <input
            id={id}
            type='number'
            aria-label={def.unit ? `${label} (${def.unit})` : label}
            value={text(value)}
            disabled={!!disabled}
            inputMode={def.integer ? 'numeric' : 'decimal'}
            min={def.min}
            max={def.max}
            step={def.step ?? (def.integer ? 1 : 'any')}
            onChange={(e) => onChange?.(e.target.value, false)}
            onBlur={(e) => onChange?.(e.target.value, true)}
          />
          {def.unit && <span className='unit'>{def.unit}</span>}
        </span>
      )
    case 'toggle':
      return (
        <button
          id={id}
          type='button'
          className='switch'
          role='switch'
          aria-label={label}
          aria-checked={value === true}
          disabled={!!disabled}
          onClick={() => onChange?.(value !== true, true)}
        />
      )
    case 'select':
      return (
        <select
          id={id}
          aria-label={label}
          disabled={!!disabled}
          value={text(value)}
          onChange={(e) => onChange?.(def.options[e.target.selectedIndex]?.value, true)}
        >
          {def.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      )
    case 'segmented':
      return (
        <div id={id} className='seg' role='radiogroup' aria-label={label}>
          {def.options.map((o) => (
            <label key={o.value}>
              <input
                type='radio'
                name={id}
                value={o.value}
                checked={o.value === value}
                disabled={!!disabled}
                onChange={() => onChange?.(o.value, true)}
              />
              <span>{o.label}</span>
            </label>
          ))}
        </div>
      )
    case 'list':
    case 'action':
    case 'readout':
      return null
  }
}
export function ListControl ({
  def,
  id,
  value,
  locked = [],
  disabled = false,
  onChange,
  extras,
}: {
  def: ListDef
  id: string
  value: unknown
  locked?: readonly ListItem[]
  disabled?: boolean
  onChange: (next: unknown, committed: boolean) => void
  extras: (item: ListItem) => ReactNode
}): ReactNode {
  const blank = (): ListItem => ({
    id: `new-${crypto.randomUUID()}`,
    ...Object.fromEntries(def.item.map((f) => [f.key, f.default])),
  })
  const [own, setOwn] = useState<ListItem[]>(() =>
    Array.isArray(value) && value.length ? (value as ListItem[]) : locked.length ? [] : [blank()]
  )
  const [previousValue, setPreviousValue] = useState(value)
  if (previousValue !== value) {
    setPreviousValue(value)
    setOwn(Array.isArray(value) && value.length ? value as ListItem[] : locked.length ? [] : [blank()])
  }
  const change = (next: ListItem[], committed: boolean): void => {
    setOwn(next)
    onChange(next, committed)
  }
  const card = (item: ListItem, i: number, isLocked: boolean): ReactNode => {
    const name = `${def.itemLabel} ${i + 1}`
    return (
      <fieldset disabled={disabled} className={`list-item${isLocked ? ' locked' : ''}`} key={item.id}>
        <div className='list-head'>
          <span className='list-title'>
            <strong>
              {(def.titleField && text(item[def.titleField])) || host(item.url) || `New ${def.itemLabel}`}
            </strong>
            {isLocked && <span className='control-note'>Set in the environment</span>}
          </span>
          <span className='list-extras'>
            {extras(item)}
            {!isLocked && (
              <button
                type='button'
                className='button'
                aria-label={`Remove ${name}`}
                onClick={() =>
                  change(
                    own.filter((o) => o.id !== item.id),
                    true
                  )}
              >
                Remove
              </button>
            )}
          </span>
        </div>
        <div>
          {def.item
            .map((f) => presentSetting(f, (key) => item[key]))
            .filter((f) => !f.hidden)
            .map((f) => (
              <div className='row' key={f.key}>
                <div className='row-text'>
                  <label className='row-label' htmlFor={`${id}-${i}-${f.key}`}>
                    {f.label}
                    <OptionalNote def={f} />
                  </label>
                  {f.help && <p className='help'>{f.help}</p>}
                </div>
                <div className='row-control'>
                  <Field
                    def={f}
                    id={`${id}-${i}-${f.key}`}
                    label={`${f.label}, ${name}`}
                    value={item[f.key]}
                    disabled={disabled || isLocked || !!f.disabled}
                    onChange={(v, committed) =>
                      change(
                        own.map((o) => (o.id === item.id ? { ...o, [f.key]: v } : o)),
                        committed
                      )}
                  />
                </div>
              </div>
            ))}
        </div>
      </fieldset>
    )
  }
  return (
    <div id={id} className='list'>
      <div className='list-items'>
        {locked.map((item, i) => card(item, i, true))}
        {own.map((item, i) => card(item, locked.length + i, false))}
        {!locked.length && !own.length && <p className='muted list-empty'>No {def.itemLabel}s yet.</p>}
      </div>
      <p>
        <button type='button' disabled={disabled} className='button add' onClick={() => change([...own, blank()], false)}>
          + Add {def.itemLabel}
        </button>
      </p>
    </div>
  )
}
export function ActionControl ({
  def,
  id,
  run,
}: {
  def: Extract<SettingDef, { type: 'action' }>
  id: string
  run: () => Promise<string | undefined>
}): ReactNode {
  const [armed, setArmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState('')
  const [error, setError] = useState(false)
  useEffect(() => {
    if (!armed) return
    const timer = setTimeout(() => setArmed(false), 4000)
    return () => clearTimeout(timer)
  }, [armed])
  return (
    <span className='action'>
      <button
        id={id}
        type='button'
        className={`button${def.danger ? ' danger' : ''}`}
        disabled={busy}
        onClick={() => {
          if (def.confirm && !armed) {
            setArmed(true)
            return
          }
          setArmed(false)
          setBusy(true)
          setError(false)
          setResult('Working…')
          run()
            .then(
              (message) => setResult(message ?? 'Done'),
              (err: unknown) => {
                setError(true)
                setResult(err instanceof Error ? err.message : String(err))
              }
            )
            .finally(() => setBusy(false))
        }}
      >
        {armed ? `Click again to ${def.button.toLowerCase()}` : def.button}
      </button>
      <span className={`action-result status${busy ? ' busy' : error ? ' error' : ''}`} role='status'>
        {result}
      </span>
    </span>
  )
}
export function Meter ({ text: label, fraction }: { text: string; fraction?: number | null }): ReactNode {
  return (
    <>
      <span>{label}</span>
      {fraction != null && (
        <span className='meter'>
          <span style={{ width: `${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%` }} />
        </span>
      )}
    </>
  )
}
