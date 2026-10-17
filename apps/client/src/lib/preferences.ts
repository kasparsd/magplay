// This browser's settings (the "browser" scope of the settings schema), stored as one JSON object in localStorage.
// The Player reads its defaults here: getPreference(PREFERENCE.speed), setPreference(PREFERENCE.volume, 0.8).
import { SETTINGS, isValueDef, validate } from '@magplay/api-contract'

/** localStorage keys this client owns, in one place so every page and the Player agree on them. */
export const STORAGE_KEYS = {
  /** Browser-scope settings: { 'player.speed': 1.25, … }. */
  preferences: 'magplay:settings',
  /** The last connection test: { at, downBytesPerSec, latencyMs }. */
  connection: 'magplay:connection',
  /** Status events up to this time (ms) have been seen in the status menu. */
  statusSeen: 'magplay:status-seen',
} as const

/** Browser-scope setting keys, by what they are. */
export const PREFERENCE = {
  volume: 'player.volume',
  muted: 'player.muted',
  speed: 'player.speed',
  audioLanguage: 'player.audioLanguage',
  subtitleLanguage: 'player.subtitleLanguage',
  autoplayNext: 'player.autoplayNext',
  statsOverlay: 'debug.statsOverlay',
  logRequests: 'debug.logRequests',
} as const

export interface Preferences {
  /** 0–1. */
  'player.volume': number
  'player.muted': boolean
  /** Playback rate: 0.75, 1, 1.25 or 1.5. */
  'player.speed': number
  /** ISO 639-1 code, or '' for the file's original track. */
  'player.audioLanguage': string
  /** ISO 639-1 code, or '' for subtitles off. */
  'player.subtitleLanguage': string
  'player.autoplayNext': boolean
  'debug.statsOverlay': boolean
  'debug.logRequests': boolean
}
export type PreferenceKey = keyof Preferences

export type PreferenceStorage = Pick<Storage, 'getItem' | 'setItem'>

const browserDefs = SETTINGS.filter(isValueDef).filter(d => d.scope === 'browser')

function storage (): PreferenceStorage | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null // blocked storage throws on access
  }
}

function readRaw (store: PreferenceStorage | null): Record<string, unknown> {
  try {
    const data: unknown = JSON.parse(store?.getItem(STORAGE_KEYS.preferences) ?? 'null')
    return data && typeof data === 'object' && !Array.isArray(data) ? data as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

/** Every browser setting, each parsed against the schema; missing or invalid values fall back to the default. */
export function readPreferences (store: PreferenceStorage | null = storage()): Preferences {
  const raw = readRaw(store)
  const out: Record<string, unknown> = {}
  for (const def of browserDefs) {
    const result = def.key in raw ? validate(def, raw[def.key]) : null
    out[def.key] = result?.ok ? result.value : def.default
  }
  return out as unknown as Preferences
}

export const getPreference = <K extends PreferenceKey>(key: K, store: PreferenceStorage | null = storage()): Preferences[K] => readPreferences(store)[key]

/** Saves one browser setting. Returns false (and saves nothing) when the value isn't valid for it. */
export function setPreference<K extends PreferenceKey> (key: K, value: Preferences[K], store: PreferenceStorage | null = storage()): boolean {
  const def = browserDefs.find(d => d.key === key)
  const result = def && validate(def, value)
  if (!result?.ok) return false
  try {
    store?.setItem(STORAGE_KEYS.preferences, JSON.stringify({ ...readRaw(store), [key]: result.value }))
  } catch {}
  return true
}
