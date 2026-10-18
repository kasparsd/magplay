// Server settings: env vars win, then data/settings.json, then the schema default.
// The file is written atomically and only ever holds what was saved in the browser; .env is never written.
import fs from 'node:fs'
import { noopLogger } from '@magplay/observability'
import type { Logger } from '@magplay/observability'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { SETTINGS, isMaskedSecret, isValueDef, validate } from '@magplay/api-contract'
import type { ListDef, ListItem, SettingMeta, SettingsResponse, ValueDef } from '@magplay/api-contract'

export type Env = Record<string, string | undefined>
/** Reads a setting from env vars when the plain "first non-empty variable" rule doesn't fit; null when unset. */
export type EnvReader = (env: Env) => unknown
export type EnvReaders = Record<string, EnvReader>

export interface Resolved {
  /** Editable values: what the settings page shows. For lists, only the items not from env. */
  values: Record<string, unknown>
  meta: Record<string, SettingMeta>
  /** Values in use: lists include their env items first. */
  effective: Record<string, unknown>
}

export const serverDefs: readonly ValueDef[] = SETTINGS.filter(isValueDef).filter(d => d.scope === 'server')

const has = (data: Record<string, unknown>, key: string): boolean => Object.prototype.hasOwnProperty.call(data, key)
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

function fromEnv (def: ValueDef, env: Env, readers: EnvReaders): { value: unknown, name: string } | null {
  const reader = readers[def.key]
  if (reader) {
    const value = reader(env)
    if (value == null) return null
    return { value, name: def.env?.find(name => env[name] !== undefined) ?? def.env?.[0] ?? def.key }
  }
  for (const name of def.env ?? []) {
    const raw = env[name]
    if (raw !== undefined && raw !== '') return { value: raw, name }
  }
  return null
}

/**
 * Resolves every server setting. An invalid env value throws (startup fails loudly, naming the
 * variable); an invalid value in the file is ignored with a warning, so a hand edit can't brick the server.
 */
export function resolve (env: Env, file: Record<string, unknown>, readers: EnvReaders = {}, defs: readonly ValueDef[] = serverDefs, logger: Logger = noopLogger): Resolved {
  const out: Resolved = { values: {}, meta: {}, effective: {} }
  for (const def of defs) {
    const envHit = fromEnv(def, env, readers)
    let envValue: unknown
    if (envHit) {
      const result = validate(def, envHit.value)
      if (!result.ok) throw new Error(`${envHit.name} ${result.error}`)
      envValue = result.value
    }
    let fileValue: unknown
    let fromFile = false
    if (has(file, def.key)) {
      const result = validate(def, file[def.key])
      if (result.ok) {
        fileValue = result.value
        fromFile = true
      } else {
        logger.warn('settings.saved.invalid', { changed: [def.key] })
      }
    }
    if (def.type === 'list') {
      // Env items are locked and listed first; items added in the browser follow them
      const locked = envHit ? envValue as ListItem[] : []
      const own = fromFile ? fileValue as ListItem[] : envHit ? [] : structuredClone(def.default) as ListItem[]
      out.values[def.key] = own
      out.effective[def.key] = [...locked, ...own]
      out.meta[def.key] = { source: fromFile ? 'file' : envHit ? 'env' : 'default', ...(envHit && { env: envHit.name, locked }) }
    } else if (envHit) {
      out.values[def.key] = out.effective[def.key] = envValue
      out.meta[def.key] = { source: 'env', env: envHit.name }
    } else {
      out.values[def.key] = out.effective[def.key] = fromFile ? fileValue : def.default
      out.meta[def.key] = { source: fromFile ? 'file' : 'default' }
    }
  }
  return out
}

function maskItem (def: ListDef, item: ListItem): ListItem {
  const masked: ListItem = { ...item }
  for (const field of def.item) if (field.type === 'secret') masked[field.key] = { set: !!item[field.key] }
  return masked
}

/** A copy safe to send to the browser or paste into a bug report: secrets become `{ set }`. */
export function mask (resolved: Pick<Resolved, 'values' | 'meta'>): SettingsResponse {
  const values: Record<string, unknown> = {}
  const meta: Record<string, SettingMeta> = {}
  for (const def of serverDefs) {
    const value = resolved.values[def.key]
    const m = resolved.meta[def.key]
    if (def.type === 'secret') values[def.key] = { set: !!value }
    else if (def.type === 'list') values[def.key] = (value as ListItem[]).map(item => maskItem(def, item))
    else values[def.key] = value
    if (m) meta[def.key] = m.locked && def.type === 'list' ? { ...m, locked: m.locked.map(item => maskItem(def, item)) } : m
  }
  return { values, meta }
}

export function readSettingsFile (file: string, logger: Logger = noopLogger): Record<string, unknown> {
  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw err
  }
  try {
    const data: unknown = JSON.parse(text)
    if (data && typeof data === 'object' && !Array.isArray(data)) return data as Record<string, unknown>
  } catch {}
  logger.warn('settings.file.invalid', {}, 'Saved settings are not a JSON object; using defaults')
  return {}
}

/** Temp file and rename, so a crash mid-write never leaves half a file. */
export function writeSettingsFile (file: string, data: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temp, JSON.stringify(data, null, 2) + '\n')
  fs.renameSync(temp, file)
}

export type UpdateResult = { ok: true, changed: string[] } | { ok: false, fields: Record<string, string> }

export interface SettingsStore {
  /** Values in use (lists include env items). */
  readonly effective: Readonly<Record<string, unknown>>
  /** Masked values and meta for GET /api/settings. */
  response: () => SettingsResponse
  /** Validates the whole patch; nothing is saved unless every field is valid. */
  update: (patch: Record<string, unknown>) => UpdateResult
  /** A list item with unsaved values, its masked secrets filled from the saved item with the same id. */
  unsavedItem: (key: string, item: Record<string, unknown>) => { ok: true, item: ListItem } | { ok: false, error: string }
  on: (event: 'changed', listener: (changed: string[]) => void) => void
}

export function createSettingsStore ({ file, env, readers = {}, logger = noopLogger }: { file: string, env: Env, readers?: EnvReaders, logger?: Logger }): SettingsStore {
  let saved = readSettingsFile(file, logger)
  let resolved = resolve(env, saved, readers, serverDefs, logger)
  const emitter = new EventEmitter()

  /** Puts saved secrets back where the browser sent `{ set: true }` (unchanged). */
  function unmask (def: ValueDef, value: unknown): unknown {
    if (def.type === 'secret') return isMaskedSecret(value) ? resolved.values[def.key] : value
    if (def.type !== 'list' || !Array.isArray(value)) return value
    const current = [...(resolved.meta[def.key]?.locked ?? []), ...(resolved.values[def.key] as ListItem[])]
    return value.map((item: unknown) => {
      if (!item || typeof item !== 'object') return item
      const next = { ...(item as Record<string, unknown>) }
      const before = current.find(c => c.id === next.id)
      for (const field of def.item) {
        if (field.type === 'secret' && isMaskedSecret(next[field.key])) next[field.key] = before?.[field.key] ?? ''
      }
      return next
    })
  }

  return {
    get effective () { return resolved.effective },
    response: () => mask(resolved),
    update (patch) {
      const fields: Record<string, string> = {}
      const next: Record<string, unknown> = {}
      for (const [key, raw] of Object.entries(patch)) {
        const def = serverDefs.find(d => d.key === key)
        if (!def) {
          fields[key] = 'Not a server setting'
          continue
        }
        const m = resolved.meta[key]
        if (m?.source === 'env' && def.type !== 'list') {
          fields[key] = `Set by ${m.env} in the environment`
          continue
        }
        const result = validate(def, unmask(def, raw))
        if (result.ok) next[key] = result.value
        else fields[key] = `${def.label} ${result.error}`
      }
      if (Object.keys(fields).length) return { ok: false, fields }
      const data = { ...saved, ...next }
      const after = resolve(env, data, readers, serverDefs, logger)
      try { writeSettingsFile(file, data) } catch (err) {
        logger.error('settings.save.failed', { err })
        throw err
      }
      const changed = serverDefs.filter(d => !same(after.effective[d.key], resolved.effective[d.key])).map(d => d.key)
      saved = data
      resolved = after
      if (changed.length) emitter.emit('changed', changed)
      return { ok: true, changed }
    },
    unsavedItem (key, item) {
      const def = serverDefs.find(d => d.key === key)
      if (def?.type !== 'list') return { ok: false, error: 'Not a list setting' }
      const result = validate(def, unmask(def, [item]))
      return result.ok ? { ok: true, item: (result.value as ListItem[])[0]! } : { ok: false, error: result.error }
    },
    on (event, listener) { emitter.on(event, listener) },
  }
}
