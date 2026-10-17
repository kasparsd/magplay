export type SettingSection = 'sources' | 'playback' | 'connection' | 'server' | 'debug'
export type SettingScope = 'server' | 'browser'
export type SettingType = 'text' | 'url' | 'secret' | 'number' | 'toggle' | 'select' | 'segmented' | 'list' | 'action' | 'readout'

export interface SelectOption { value: string | number | boolean, label: string }
export interface SettingDef {
  key: string
  section: SettingSection
  scope: SettingScope
  type: SettingType
  label: string
  /** Short explanation shown below the control. */
  help?: string
  /** Optional longer explanation behind the shared (i) disclosure. */
  moreHelp?: string
  default?: unknown
  env?: string | string[]
  apply?: 'live' | 'restart'
  min?: number
  max?: number
  step?: number
  unit?: string
  options?: SelectOption[]
  integer?: boolean
}

const positive = (key: string, label: string, defaultValue: number, section: SettingSection, env: string | string[], unit: string, { min = 0.01, step = 0.01, integer = false, apply = 'live' }: { min?: number, step?: number, integer?: boolean, apply?: 'live' | 'restart' } = {}): SettingDef => ({ key, label, default: defaultValue, section, scope: 'server', type: 'number', env, min, step, unit, integer, apply })

export const settingsSchema: SettingDef[] = [
  { key: 'sources', section: 'sources', scope: 'server', type: 'list', label: 'Indexer sources', env: ['TORZNAB_URL', 'JACKETT_URL', 'PROWLARR_URL'], apply: 'live' },
  { key: 'bitmagnetUrl', section: 'sources', scope: 'server', type: 'url', label: 'BitMagnet address', help: 'Used for Explore.', moreHelp: 'Use the base HTTP address. The Torznab feed address also works; magplay derives its origin.', default: '', env: 'BITMAGNET_URL', apply: 'live' },
  positive('searchTimeoutS', 'Search timeout', 30, 'sources', 'SEARCH_TIMEOUT_S', 'seconds', { min: 1, step: 1, integer: true }),
  { key: 'allowTranscode', section: 'playback', scope: 'server', type: 'toggle', label: 'Allow video transcoding', help: 'Re-encodes video the browser cannot play.', moreHelp: 'Transcoding uses significant NAS CPU. An external player is usually better for high-resolution HEVC.', default: false, env: 'ALLOW_VIDEO_TRANSCODE', apply: 'live' },
  { key: 'transcodeMaxHeight', section: 'playback', scope: 'server', type: 'select', label: 'Transcode resolution', default: 720, env: 'TRANSCODE_MAX_HEIGHT', apply: 'live', options: [{ value: 480, label: '480p' }, { value: 720, label: '720p' }, { value: 1080, label: '1080p' }] },
  positive('maxHlsSessions', 'Simultaneous conversions', 2, 'playback', 'MAX_HLS_SESSIONS', 'sessions', { min: 1, step: 1, integer: true }),
  { key: 'audioLanguage', section: 'playback', scope: 'browser', type: 'text', label: 'Preferred audio language', default: '', help: 'Language code, for example en.' },
  { key: 'subtitleLanguage', section: 'playback', scope: 'browser', type: 'text', label: 'Preferred subtitles language', default: '', help: 'Language code, for example en.' },
  { key: 'speed', section: 'playback', scope: 'browser', type: 'select', label: 'Default speed', default: 1, options: [{ value: 0.75, label: '0.75×' }, { value: 1, label: 'Normal (1×)' }, { value: 1.25, label: '1.25×' }, { value: 1.5, label: '1.5×' }, { value: 2, label: '2×' }] },
  { key: 'autoplayNext', section: 'playback', scope: 'browser', type: 'toggle', label: 'Play next episode automatically', default: true },
  { ...positive('cacheMaxGb', 'Torrent cache limit', 50, 'server', 'CACHE_MAX_GB', 'GB'), moreHelp: 'Magplay evicts least-recently-used torrent data after this soft limit. Active downloads are never evicted.' },
  { ...positive('minFreeGb', 'Free-space floor', 0.25, 'server', 'MIN_FREE_GB', 'GB'), moreHelp: 'New conversions stop when free space drops below this reserve.' },
  positive('idleTorrentMin', 'Unload idle torrents after', 30, 'server', 'IDLE_TORRENT_MIN', 'minutes', { min: 1, step: 1, integer: true }),
  { key: 'dhtEnabled', section: 'server', scope: 'server', type: 'toggle', label: 'Use DHT', default: true, env: 'DHT_ENABLED', apply: 'restart' },
  { key: 'lsdEnabled', section: 'server', scope: 'server', type: 'toggle', label: 'Use local peer discovery', default: true, env: 'LSD_ENABLED', apply: 'restart' },
  { key: 'extraTrackers', section: 'server', scope: 'server', type: 'text', label: 'Extra trackers', default: '', env: 'EXTRA_TRACKERS', apply: 'live', help: 'Comma-separated announce URLs.' },
  { key: 'port', section: 'server', scope: 'server', type: 'number', label: 'Web port', default: 8080, env: 'PORT', min: 1, max: 65535, apply: 'restart' },
  { key: 'torrentPort', section: 'server', scope: 'server', type: 'number', label: 'Torrent port', default: 6881, env: 'TORRENT_PORT', min: 0, max: 65535, apply: 'restart', help: 'Use 0 to let the operating system choose a free port.' },
  { key: 'cacheDir', section: 'server', scope: 'server', type: 'text', label: 'Cache folder', default: 'data', env: 'CACHE_DIR', apply: 'restart' },
  { key: 'statsOverlay', section: 'debug', scope: 'browser', type: 'toggle', label: 'Show playback stats overlay', default: false },
  { key: 'requestLogging', section: 'debug', scope: 'browser', type: 'toggle', label: 'Log API requests in this browser', default: false },
]

export const serverSettings = settingsSchema.filter(def => def.scope === 'server')
export const browserSettings = settingsSchema.filter(def => def.scope === 'browser')
export const settingByKey = new Map(settingsSchema.map(def => [def.key, def]))

export interface FieldError { key: string, message: string }

/** Validate one value at the API boundary. Complex source rows are checked here too. */
export function validateSetting (def: SettingDef, value: unknown): string | null {
  if (def.type === 'toggle') return typeof value === 'boolean' ? null : 'Choose on or off.'
  if (def.type === 'number' || (def.type === 'select' && typeof def.default === 'number')) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return 'Enter a number.'
    if (def.min != null && value < def.min) return `Enter ${def.min} or more.`
    if (def.max != null && value > def.max) return `Enter ${def.max} or less.`
    if (def.integer && !Number.isSafeInteger(value)) return 'Enter a whole number.'
    if (def.options && !def.options.some(option => option.value === value)) return 'Choose one of the available options.'
    return null
  }
  if (def.type === 'list') {
    if (!Array.isArray(value)) return 'Provide a list of sources.'
    for (const source of value) {
      if (!source || typeof source !== 'object') return 'Each source needs a type, name and address.'
      const row = source as Record<string, unknown>
      if (!['torznab', 'jackett', 'prowlarr'].includes(String(row.type))) return 'Choose a supported source type.'
      if (typeof row.name !== 'string' || !row.name.trim()) return 'Each source needs a name.'
      if (!isHttpUrl(row.url)) return 'Each source needs an http(s) address.'
      if (row.apiKey != null && typeof row.apiKey !== 'string') return 'An API key must be text.'
    }
    return null
  }
  if (typeof value !== 'string') return 'Enter text.'
  if (def.type === 'url' && value && !isHttpUrl(value)) return 'Enter an http(s) address.'
  return null
}

const isHttpUrl = (value: unknown): boolean => typeof value === 'string' && /^https?:\/\/[^/\s]+/i.test(value)
