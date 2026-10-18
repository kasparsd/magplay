// This browser's settings (the "browser" scope of the settings schema), in localStorage.
// Each one has its own key, the same keys the Player reads and writes through recall()/remember():
// the schema key 'player.speed' is stored as JSON under 'magplay:player:speed'.
import { SETTINGS, isValueDef, validate } from '@magplay/api-contract'

/** localStorage keys this client owns, in one place so every page and the Player agree on them. */
export const STORAGE_KEYS = {
  /** The last connection test: { at, downBytesPerSec, latencyMs }. */
  connection: 'magplay:connection',
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

/** The localStorage key for one browser setting: 'player.speed' → 'magplay:player:speed'. */
export const preferenceStorageKey = (key: string): string => `magplay:${key.replace(/\./g, ':')}`

export interface Preferences {
  /** 0–1. */
  'player.volume': number
  'player.muted': boolean
  /** Playback rate: 0.75, 1, 1.25 or 1.5. */
  'player.speed': number
  /** A language code ("en", or "eng" as a file names it), or '' for the first track. The Player stores null for that. */
  'player.audioLanguage': string
  /** A language code, 'off', or 'any' for whichever track there is. */
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

function readOne (store: PreferenceStorage | null, key: string): unknown {
  try {
    return JSON.parse(store?.getItem(preferenceStorageKey(key)) ?? 'null') as unknown
  } catch {
    return null
  }
}

/** Every browser setting, each parsed against the schema; missing or invalid values fall back to the default. */
export function readPreferences (store: PreferenceStorage | null = storage()): Preferences {
  const out: Record<string, unknown> = {}
  for (const def of browserDefs) {
    const raw = readOne(store, def.key)
    const result = raw === null ? null : validate(def, raw)
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
  // The Player keeps "no audio preference" as null
  const stored = key === PREFERENCE.audioLanguage && result.value === '' ? null : result.value
  try {
    store?.setItem(preferenceStorageKey(key), JSON.stringify(stored))
  } catch {}
  return true
}
