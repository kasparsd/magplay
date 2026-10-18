// Status checks and events: GET /api/status, merged in the client with browser-side checks.

export type StatusLevel = 'ok' | 'warn' | 'error' | 'unknown'

export interface StatusAction {
  label: string
  /** Usually a settings deep link: '/settings#sources'. */
  href: string
}

/** One check's latest result. */
export interface StatusCheck {
  id: string
  label: string
  level: StatusLevel
  /** Required checks must have run and passed before the overall level can be ok. */
  required: boolean
  /** Short value shown on the right: '84 ms', '41.8 GB free'. */
  value?: string
  /** Plain sentence for a problem. */
  message?: string
  action?: StatusAction
  /** When it last ran, ms since the epoch. */
  at?: number
}

/** A status change or a notable action ("Settings saved: …"). */
export interface StatusEvent {
  at: number
  checkId: string
  level: StatusLevel
  message: string
}

/** GET /api/status. */
export interface StatusResponse {
  level: StatusLevel
  checks: StatusCheck[]
  events: StatusEvent[]
}

const SEVERITY: Record<StatusLevel, number> = { error: 3, warn: 2, unknown: 1, ok: 0 }

/** Sorts worst first, keeping order otherwise. */
export const byLevel = (a: StatusCheck, b: StatusCheck): number => SEVERITY[b.level] - SEVERITY[a.level]

/**
 * The overall level: the worst result. Unknown only counts while a required check hasn't run,
 * so an optional check that was never run (the speed test) doesn't hide a healthy server,
 * and the menu never claims health it hasn't measured.
 */
export function overallLevel (checks: readonly StatusCheck[]): StatusLevel {
  if (checks.some(c => c.level === 'error')) return 'error'
  if (checks.some(c => c.level === 'warn')) return 'warn'
  if (!checks.length || checks.some(c => c.required && c.level === 'unknown')) return 'unknown'
  return 'ok'
}

/** Checks that need a look: warnings and errors. */
export const problems = (checks: readonly StatusCheck[]): StatusCheck[] => checks.filter(c => c.level === 'warn' || c.level === 'error')

/** GET /api/debug. */
export interface DebugInfo {
  version: string
  node: string
  uptimeS: number
  ffmpeg: string | null
  ffprobe: string | null
  /** Busy slots and limits for each kind of heavy work. */
  resources: Array<{ id: string, label: string, used: number, limit: number, unit?: 'bytes' }>
  disk: { free: number, size: number, cacheBytes: number, cacheMaxBytes: number } | null
  log: Array<{ at: number, level: 'debug' | 'info' | 'warn' | 'error', text: string }>
}
