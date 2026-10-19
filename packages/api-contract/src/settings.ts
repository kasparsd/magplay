// The settings schema: one declarative entry per setting, shared by the server (resolution,
// validation, persistence) and the client (the /settings page renders one control per entry).

export type SectionId = 'sources' | 'playback' | 'storage' | 'debug'
/** Server settings apply to everyone and are saved on the server; browser settings live in one browser's localStorage. */
export type SettingScope = 'server' | 'browser'

export interface SectionDef {
  id: SectionId
  label: string
  intro: string
}

export const SECTIONS: readonly SectionDef[] = [
  { id: 'sources', label: 'Sources', intro: 'Sources for search results and Explore.' },
  { id: 'playback', label: 'Playback', intro: 'Convert videos this browser cannot play.' },
  { id: 'storage', label: 'Storage', intro: 'Disk space for downloaded torrents and temporary video files.' },
  { id: 'debug', label: 'Debug', intro: 'Server status, logs and troubleshooting details.' },
]

export interface SettingPresentation {
  hidden?: boolean
  disabled?: boolean
  help?: string
  placeholder?: string
}

export interface SettingRule extends SettingPresentation {
  when: { key: string, equals: string | number | boolean }
}

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
  /** Hidden unless a presentation rule overrides it; stored values remain validated. */
  hidden?: boolean
  /** Presentation overrides based on another setting, or a sibling field inside a list item. */
  rules?: readonly SettingRule[]
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
  /** An empty value is allowed. */
  optional?: boolean
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

export const SETTINGS: readonly SettingDef[] = [
  // Sources
  {
    key: 'sources',
    section: 'sources',
    scope: 'server',
    type: 'list',
    label: 'Search sources',
    help: 'Add Torznab, Jackett or Prowlarr sources. Each search checks all sources.',
    itemLabel: 'source',
    env: ['TORZNAB_URL', 'JACKETT_URL', 'PROWLARR_URL'],
    default: [],
    item: [
      {
        key: 'type',
        type: 'select',
        label: 'Source type',
        default: 'torznab',
        options: [{ value: 'torznab', label: 'Torznab' }, { value: 'jackett', label: 'Jackett' }, { value: 'prowlarr', label: 'Prowlarr' }],
      },
      {
        key: 'url',
        type: 'url',
        label: 'Source URL',
        default: '',
        placeholder: 'http://bitmagnet:3333/torznab/api',
        rules: [
          { when: { key: 'type', equals: 'jackett' }, placeholder: 'http://jackett:9117' },
          { when: { key: 'type', equals: 'prowlarr' }, placeholder: 'http://prowlarr:9696' },
        ]
      },
      {
        key: 'apiKey',
        type: 'secret',
        label: 'API key',
        default: '',
        optional: true,
        placeholder: 'Paste the key',
        help: 'Leave blank if this feed does not require an API key.',
        rules: [
          { when: { key: 'type', equals: 'jackett' }, help: 'Use the API key from Jackett settings.' },
          { when: { key: 'type', equals: 'prowlarr' }, help: 'Use the API key from Prowlarr settings.' },
        ]
      },
      {
        key: 'indexer',
        type: 'text',
        label: 'Indexer filter',
        default: '',
        optional: true,
        placeholder: 'All',
        hidden: true,
        rules: [
          { when: { key: 'type', equals: 'jackett' }, hidden: false, help: 'Enter an indexer ID or filter. Leave blank to search all indexers.' },
          { when: { key: 'type', equals: 'prowlarr' }, hidden: false, help: 'Enter indexer IDs separated by commas. Leave blank to search all indexers.' },
        ]
      },
    ],
  },
  {
    key: 'explore.bitmagnetUrl',
    section: 'sources',
    scope: 'server',
    type: 'url',
    label: 'BitMagnet URL',
    help: 'Used by Explore. Detected automatically from a BitMagnet Torznab URL.',
    env: ['BITMAGNET_URL'],
    default: '',
    optional: true,
    placeholder: 'http://bitmagnet:3333',
  },
  { key: 'content.showAdult', section: 'sources', scope: 'server', type: 'toggle', label: 'Show adult content in Explore', help: 'Show classified adult releases in Explore and its title pages. This does not filter search results from your sources.', env: ['SHOW_ADULT_CONTENT', 'ALLOW_ADULT'], default: false },
  { key: 'search.timeoutS', section: 'sources', scope: 'server', type: 'number', label: 'Search timeout', help: 'Stop waiting for a source after this many seconds.', env: ['SEARCH_TIMEOUT_S'], default: 30, unit: 's', min: 1, max: 600 },

  // Playback, server
  { key: 'transcode.allow', section: 'playback', scope: 'server', type: 'toggle', label: 'Convert unsupported video', help: 'Convert unsupported video formats on the server. Uses more CPU.', env: ['ALLOW_VIDEO_TRANSCODE'], default: false },
  {
    key: 'transcode.maxHeight',
    section: 'playback',
    scope: 'server',
    type: 'segmented',
    label: 'Conversion resolution',
    help: 'Maximum resolution for converted video. Higher resolutions use more CPU.',
    rules: [{ when: { key: 'transcode.allow', equals: false }, disabled: true, help: 'Turn on video conversion to change the resolution.' }],
    env: ['TRANSCODE_MAX_HEIGHT'],
    default: 720,
    options: [{ value: 480, label: '480p' }, { value: 720, label: '720p' }, { value: 1080, label: '1080p' }],
  },

  // Playback, this browser: state the Player remembers (its own recall()/remember() keys), kept in the
  // schema so stored values are validated and diagnostics can include them. Nothing here is on the page.
  { key: 'player.volume', section: 'playback', scope: 'browser', type: 'number', label: 'Volume', default: 1, min: 0, max: 1, step: 0.05, hidden: true },
  { key: 'player.muted', section: 'playback', scope: 'browser', type: 'toggle', label: 'Muted', default: false, hidden: true },

  // Storage
  { key: 'cache.usage', section: 'storage', scope: 'server', type: 'readout', label: 'Disk usage' },
  { key: 'cache.maxGb', section: 'storage', scope: 'server', type: 'number', label: 'Torrent cache limit', help: 'Remove least recently used torrents when the cache exceeds this limit.', env: ['CACHE_MAX_GB'], default: 50, unit: 'GB', min: 1 },
  { key: 'cache.minFreeGb', section: 'storage', scope: 'server', type: 'number', label: 'Minimum free disk space', help: 'Stop video conversions when free disk space falls below this amount.', env: ['MIN_FREE_GB'], default: 0.25, unit: 'GB', min: 0.01, step: 0.05 },
  { key: 'cache.hlsMaxGb', section: 'storage', scope: 'server', type: 'number', label: 'Conversion cache limit', help: 'Maximum disk space for temporary video conversion files.', env: ['HLS_MAX_GB'], default: 8, unit: 'GB', min: 0.1 },

  // Debug
  { key: 'debug.server', section: 'debug', scope: 'server', type: 'readout', label: 'Server', group: 'Server' },
  { key: 'debug.resources', section: 'debug', scope: 'server', type: 'readout', label: 'In use', group: 'Server' },
  { key: 'debug.diagnostics', section: 'debug', scope: 'server', type: 'action', label: 'Diagnostics', help: 'Copy server details, settings and logs as JSON. API keys are hidden.', button: 'Copy diagnostics', group: 'Server' },
  { key: 'connection.result', section: 'debug', scope: 'browser', type: 'readout', label: 'Last test', group: 'Speed test' },
  { key: 'connection.test', section: 'debug', scope: 'browser', type: 'action', label: 'Connection to server', group: 'Speed test', help: 'Download test data for about 5 seconds. Results are saved in this browser.', button: 'Run speed test' },

  { key: 'debug.log', section: 'debug', scope: 'server', type: 'readout', label: 'Log', group: 'Log' },
  { key: 'debug.clearHls', section: 'debug', scope: 'server', type: 'action', label: 'Clear conversion cache', help: 'Stop active conversions and delete temporary video files. Downloaded torrents are kept.', button: 'Clear conversion cache', confirm: true, danger: true, group: 'Maintenance' },
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
