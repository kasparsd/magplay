// The settings schema: one declarative entry per setting, shared by the server (resolution,
// validation, persistence) and the client (the /settings page renders one control per entry).

export type SectionId = 'sources' | 'playback' | 'connection' | 'storage' | 'debug'
/** Server settings apply to everyone and are saved on the server; browser settings live in one browser's localStorage. */
export type SettingScope = 'server' | 'browser'

export interface SectionDef {
  id: SectionId
  label: string
  intro: string
}

export const SECTIONS: readonly SectionDef[] = [
  { id: 'sources', label: 'Sources', intro: 'Where search and Explore get their results.' },
  { id: 'playback', label: 'Playback', intro: 'How files play, on the server and in this browser’s player.' },
  { id: 'connection', label: 'Connection', intro: 'The link between this device and the server: the part of playback nothing else measures.' },
  { id: 'storage', label: 'Storage', intro: 'How much of the server’s disk torrents and conversions may use.' },
  { id: 'debug', label: 'Debug', intro: 'What the server is doing right now, for working out why something is slow or broken.' },
]

interface Common {
  /** Dotted, stable id: 'cache.maxGb'. Also the key in settings.json and localStorage. */
  key: string
  section: SectionId
  scope: SettingScope
  label: string
  help?: string
  /** Env vars that set this server setting. When set they win, and the field is read-only. */
  env?: readonly string[]
  /** Cards within a section; settings with the same group render together. */
  group?: string
  /** Stored and validated but not rendered (state the player remembers, like volume). */
  hidden?: boolean
}

export interface TextDef extends Common {
  type: 'text' | 'url'
  default: string
  placeholder?: string
  /** An empty value is allowed. */
  optional?: boolean
}

export interface SecretDef extends Common {
  type: 'secret'
  default: string
  placeholder?: string
}

export interface NumberDef extends Common {
  type: 'number'
  default: number
  unit?: string
  min?: number
  max?: number
  step?: number
  integer?: boolean
}

export interface ToggleDef extends Common {
  type: 'toggle'
  default: boolean
}

export interface SettingOption {
  value: string | number
  label: string
}

export interface ChoiceDef extends Common {
  type: 'select' | 'segmented'
  default: string | number
  options: readonly SettingOption[]
  /** Also accept a language code that isn't listed (the Player remembers track languages as files name them: "eng"). */
  otherLanguages?: boolean
}

/** A field inside a list item. Its key is relative to the item: 'url'. */
export type ItemFieldDef = Omit<TextDef, 'section' | 'scope'> | Omit<SecretDef, 'section' | 'scope'> | Omit<ChoiceDef, 'section' | 'scope'>

export type ListItem = Record<string, unknown> & { id: string }

export interface ListDef extends Common {
  type: 'list'
  default: readonly ListItem[]
  item: readonly ItemFieldDef[]
  /** Names one item: 'source'. */
  itemLabel: string
  /** The item field used as each item's heading. */
  titleField?: string
}

/** A button the page wires to a handler (Test, Clear cache, Copy diagnostics). Not stored. */
export interface ActionDef extends Common {
  type: 'action'
  button: string
  /** Asks for a second click before running. */
  confirm?: boolean
  danger?: boolean
}

/** A read-only value or meter the page fills in (disk use, versions). Not stored. */
export interface ReadoutDef extends Common {
  type: 'readout'
}

export type ValueDef = TextDef | SecretDef | NumberDef | ToggleDef | ChoiceDef | ListDef
export type SettingDef = ValueDef | ActionDef | ReadoutDef
export type SettingType = SettingDef['type']

export const isValueDef = (def: SettingDef): def is ValueDef => def.type !== 'action' && def.type !== 'readout'

const LANGUAGES: readonly SettingOption[] = [
  { value: 'en', label: 'English' },
  { value: 'es', label: 'Spanish' },
  { value: 'fr', label: 'French' },
  { value: 'de', label: 'German' },
  { value: 'it', label: 'Italian' },
  { value: 'pt', label: 'Portuguese' },
  { value: 'ru', label: 'Russian' },
  { value: 'lv', label: 'Latvian' },
  { value: 'ja', label: 'Japanese' },
]

export const SETTINGS: readonly SettingDef[] = [
  // Sources
  {
    key: 'sources',
    section: 'sources',
    scope: 'server',
    type: 'list',
    label: 'Indexers',
    help: 'Torznab feeds, Jackett or Prowlarr. Every search asks them all at once.',
    itemLabel: 'source',
    titleField: 'name',
    env: ['TORZNAB_URL', 'JACKETT_URL', 'PROWLARR_URL'],
    default: [],
    item: [
      {
        key: 'type',
        type: 'select',
        label: 'Type',
        default: 'torznab',
        options: [{ value: 'torznab', label: 'Torznab' }, { value: 'jackett', label: 'Jackett' }, { value: 'prowlarr', label: 'Prowlarr' }],
      },
      { key: 'name', type: 'text', label: 'Name', default: '', optional: true, placeholder: 'From the address' },
      { key: 'url', type: 'url', label: 'Address', default: '', placeholder: 'http://bitmagnet:3333/torznab/api' },
      { key: 'apiKey', type: 'secret', label: 'API key', default: '', placeholder: 'Paste the key' },
      { key: 'indexer', type: 'text', label: 'Indexer filter', help: 'Jackett: an indexer id, all, or a filter. Prowlarr: comma-separated ids, -2 for all.', default: '', optional: true, placeholder: 'All' },
    ],
  },
  {
    key: 'explore.bitmagnetUrl',
    section: 'sources',
    scope: 'server',
    type: 'url',
    label: 'BitMagnet address',
    help: 'For Explore. Found from a Torznab address when it uses BitMagnet’s path.',
    env: ['BITMAGNET_URL'],
    default: '',
    optional: true,
    placeholder: 'http://bitmagnet:3333',
  },
  { key: 'search.timeoutS', section: 'sources', scope: 'server', type: 'number', label: 'Search timeout', help: 'Slow sources are dropped from results after this.', env: ['SEARCH_TIMEOUT_S'], default: 30, unit: 's', min: 1, max: 600 },

  // Playback, server
  { key: 'transcode.allow', section: 'playback', scope: 'server', type: 'toggle', label: 'Allow video transcoding', help: 'Converts video the browser can’t play. Uses a lot of server CPU.', env: ['ALLOW_VIDEO_TRANSCODE'], default: false },
  {
    key: 'transcode.maxHeight',
    section: 'playback',
    scope: 'server',
    type: 'segmented',
    label: 'Transcode resolution',
    help: 'Higher looks better and needs a faster server.',
    env: ['TRANSCODE_MAX_HEIGHT'],
    default: 720,
    options: [{ value: 480, label: '480p' }, { value: 720, label: '720p' }, { value: 1080, label: '1080p' }],
  },

  // Playback, this browser
  {
    key: 'player.subtitleLanguage',
    section: 'playback',
    scope: 'browser',
    type: 'select',
    label: 'Preferred subtitles',
    help: 'The Player also remembers the last subtitles you chose.',
    default: 'off',
    otherLanguages: true,
    options: [{ value: 'off', label: 'Off' }, { value: 'any', label: 'Any available' }, ...LANGUAGES],
  },
  {
    key: 'player.audioLanguage',
    section: 'playback',
    scope: 'browser',
    type: 'select',
    label: 'Preferred audio',
    help: 'The Player also remembers the last audio language you chose.',
    default: '',
    otherLanguages: true,
    options: [{ value: '', label: 'First track' }, ...LANGUAGES],
  },
  {
    key: 'player.speed',
    section: 'playback',
    scope: 'browser',
    type: 'segmented',
    label: 'Default speed',
    default: 1,
    options: [0.5, 0.75, 1, 1.25, 1.5, 2].map(value => ({ value, label: `${value}×` })),
  },
  { key: 'player.volume', section: 'playback', scope: 'browser', type: 'number', label: 'Volume', default: 1, min: 0, max: 1, step: 0.05, hidden: true },
  { key: 'player.muted', section: 'playback', scope: 'browser', type: 'toggle', label: 'Muted', default: false, hidden: true },

  // Connection
  { key: 'connection.result', section: 'connection', scope: 'browser', type: 'readout', label: 'Last test' },
  { key: 'connection.test', section: 'connection', scope: 'browser', type: 'action', label: 'Speed test', help: 'Downloads from the server for about 5 seconds. The result stays in this browser.', button: 'Test now' },

  // Storage
  { key: 'cache.usage', section: 'storage', scope: 'server', type: 'readout', label: 'Disk' },
  { key: 'cache.maxGb', section: 'storage', scope: 'server', type: 'number', label: 'Torrent cache limit', help: 'Oldest torrents are removed past this.', env: ['CACHE_MAX_GB'], default: 50, unit: 'GB', min: 1 },
  { key: 'cache.minFreeGb', section: 'storage', scope: 'server', type: 'number', label: 'Keep free on disk', help: 'Conversions stop below this.', env: ['MIN_FREE_GB'], default: 0.25, unit: 'GB', min: 0.01, step: 0.05 },
  { key: 'cache.hlsMaxGb', section: 'storage', scope: 'server', type: 'number', label: 'Conversion storage', help: 'Space for remux and transcode segments.', env: ['HLS_MAX_GB'], default: 8, unit: 'GB', min: 0.1 },

  // Debug
  { key: 'debug.server', section: 'debug', scope: 'server', type: 'readout', label: 'Server', group: 'Server' },
  { key: 'debug.resources', section: 'debug', scope: 'server', type: 'readout', label: 'In use', group: 'Server' },
  { key: 'debug.diagnostics', section: 'debug', scope: 'server', type: 'action', label: 'Diagnostics', help: 'Versions, settings and status as JSON, with secrets removed.', button: 'Copy diagnostics', group: 'Server' },
  { key: 'debug.log', section: 'debug', scope: 'server', type: 'readout', label: 'Log', group: 'Log' },
  { key: 'debug.clearHls', section: 'debug', scope: 'server', type: 'action', label: 'Clear conversion cache', help: 'Stops conversions in progress and deletes their segments. Torrents stay.', button: 'Clear', confirm: true, danger: true, group: 'Maintenance' },
]

export const settingDef = (key: string): SettingDef | undefined => SETTINGS.find(d => d.key === key)

export type ValidationResult = { ok: true, value: unknown } | { ok: false, error: string }

const fail = (error: string): ValidationResult => ({ ok: false, error })
const pass = (value: unknown): ValidationResult => ({ ok: true, value })

const TRUE = /^(1|true|yes|on)$/i
const FALSE = /^(0|false|no|off)$/i

// No URL global here: this package runs without DOM or Node types
const isHttpUrl = (value: string): boolean => /^https?:\/\/[^\s/?#]+(?:[/?#]\S*)?$/i.test(value)

type FieldDef = ValueDef | ItemFieldDef

function validateScalar (def: Exclude<FieldDef, ListDef>, value: unknown): ValidationResult {
  switch (def.type) {
    case 'text':
    case 'url':
    case 'secret': {
      if (typeof value !== 'string') return fail('must be text')
      const text = value.trim()
      if (def.type === 'secret') return pass(text)
      if (!text) return def.optional ? pass('') : fail('can’t be empty')
      if (def.type === 'url' && !isHttpUrl(text)) return fail('must be an http:// or https:// address')
      return pass(text)
    }
    case 'number': {
      const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
      if (typeof n !== 'number' || !Number.isFinite(n)) return fail('must be a number')
      if (def.integer && !Number.isInteger(n)) return fail('must be a whole number')
      if (def.min !== undefined && n < def.min) return fail(`must be at least ${def.min}`)
      if (def.max !== undefined && n > def.max) return fail(`must be at most ${def.max}`)
      return pass(n)
    }
    case 'toggle':
      if (typeof value === 'boolean') return pass(value)
      if (typeof value === 'string' && TRUE.test(value.trim())) return pass(true)
      if (typeof value === 'string' && FALSE.test(value.trim())) return pass(false)
      return fail('must be on or off')
    case 'select':
    case 'segmented': {
      // Env values arrive as strings, so '720' matches the option 720
      const match = def.options.find(o => o.value === value || String(o.value) === String(value))
      if (!match && 'otherLanguages' in def && def.otherLanguages && typeof value === 'string' && /^[a-z]{2,3}([-_][a-z0-9]+)?$/i.test(value)) return pass(value)
      return match ? pass(match.value) : fail(`must be one of ${def.options.map(o => o.label).join(', ')}`)
    }
  }
}

/**
 * Checks and normalizes a value against its definition: trims text, parses numeric and boolean
 * strings (so env vars validate the same way), and fills list item ids. Used by the server for
 * env, settings.json and PATCH bodies, and by the client for localStorage and before saving.
 */
export function validate (def: ValueDef, value: unknown): ValidationResult {
  if (def.type !== 'list') return validateScalar(def, value)
  if (!Array.isArray(value)) return fail('must be a list')
  const items: ListItem[] = []
  for (const [i, raw] of value.entries()) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail(`${def.itemLabel} ${i + 1} must be an object`)
    const source = raw as Record<string, unknown>
    const item: ListItem = { id: typeof source.id === 'string' && source.id ? source.id : `item-${i}-${Math.random().toString(36).slice(2, 10)}` }
    for (const field of def.item) {
      const result = validateScalar(field, source[field.key] ?? field.default)
      if (!result.ok) return fail(`${def.itemLabel} ${i + 1}: ${field.label.toLowerCase()} ${result.error}`)
      item[field.key] = result.value
    }
    items.push(item)
  }
  return pass(items)
}

/** Every stored setting's default, keyed by setting key. */
export function defaults (scope: SettingScope): Record<string, unknown> {
  return Object.fromEntries(SETTINGS.filter(isValueDef).filter(d => d.scope === scope).map(d => [d.key, JSON.parse(JSON.stringify(d.default)) as unknown]))
}

/** A secret as the server sends it: whether one is saved, never its value. */
export interface MaskedSecret {
  set: boolean
}

export const isMaskedSecret = (value: unknown): value is MaskedSecret =>
  !!value && typeof value === 'object' && !Array.isArray(value) && typeof (value as { set?: unknown }).set === 'boolean'

/** Where a server setting's value came from. */
export interface SettingMeta {
  source: 'env' | 'file' | 'default'
  /** The env var that set it. */
  env?: string
  /** List settings: items from env vars, shown read-only before the editable ones. */
  locked?: ListItem[]
}

/** GET /api/settings and a successful PATCH. Secrets are masked. */
export interface SettingsResponse {
  values: Record<string, unknown>
  meta: Record<string, SettingMeta>
}

/** PATCH /api/settings failure: 400 with an error per setting key. */
export interface SettingsErrorResponse {
  error: string
  fields: Record<string, string>
}

/** POST /api/settings/test: one list item (a source) checked with unsaved values. */
export interface SettingsTestRequest {
  key: string
  item: Record<string, unknown>
}
