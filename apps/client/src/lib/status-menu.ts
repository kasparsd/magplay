// Overall health for the top bar's status menu (components/StatusMenu.tsx) and the Settings page: server checks from
// GET /api/status, with the browser's own checks (the connection test) merged in. The ['status'] query polls it.
import { byLevel, overallLevel, problems } from '@magplay/api-contract'
import type { StatusCheck, StatusLevel, StatusResponse } from '@magplay/api-contract'
import { connectionLevel, connectionWarning, readConnection } from './speedtest.ts'
import { formatSpeed } from './format.ts'

/** The connection test as a check: unknown until it has run in this browser. */
export function connectionCheck (now = Date.now()): StatusCheck {
  const result = readConnection()
  const level = connectionLevel(result, now)
  const href = '/settings#debug'
  return {
    id: 'connection',
    label: 'Your connection',
    required: false,
    level,
    ...(result && level !== 'unknown' && { value: `${formatSpeed(result.downBytesPerSec)} · ${Math.round(result.latencyMs)} ms`, at: result.at }),
    ...(level === 'warn' && result && { message: connectionWarning(result), action: { label: 'Test again', href } }),
    ...(level === 'unknown' && { value: 'Not tested', action: { label: 'Test it', href } }),
  }
}

export interface MergedStatus extends StatusResponse {
  /** False when the server couldn't be reached. */
  reachable: boolean
}

/** Merge server checks with the current browser-local connection check. */
export function mergeStatus (server: StatusResponse | null): MergedStatus {
  const checks = [...(server?.checks.filter(c => c.id !== 'connection') ?? []), connectionCheck()]
  if (!server) checks.unshift({ id: 'server', label: 'magplay server', required: true, level: 'error', message: 'The server didn’t answer. Is it running?' })
  return { level: overallLevel(checks), checks: checks.sort(byLevel), reachable: !!server }
}

export const HEADLINES: Record<StatusLevel, string> = { ok: 'All good', warn: 'Needs attention', error: 'Something isn’t working', unknown: 'Not checked yet' }
export const LEVEL_NAMES: Record<StatusLevel, string> = { ok: 'OK', warn: 'Warning', error: 'Problem', unknown: 'Not checked' }

export function summary (status: MergedStatus): string {
  const errors = status.checks.filter(c => c.level === 'error').length
  const warnings = status.checks.filter(c => c.level === 'warn').length
  if (errors && warnings) return `${errors} ${errors === 1 ? 'problem' : 'problems'}, ${warnings} ${warnings === 1 ? 'warning' : 'warnings'}`
  if (errors) return errors === 1 ? '1 check is failing' : `${errors} checks are failing`
  if (warnings) return warnings === 1 ? '1 check needs a look' : `${warnings} checks need a look`
  if (status.level === 'unknown') return 'Some checks haven’t run yet'
  return 'Every check passed'
}

/** The status button's accessible name carries the state: "Status: 2 problems". */
export function buttonLabel (status: MergedStatus | null): string {
  if (!status) return 'Status: checking'
  const n = problems(status.checks).length
  if (n) return `Status: ${n} ${n === 1 ? 'problem' : 'problems'}`
  return `Status: ${status.level === 'ok' ? 'all good' : 'not checked yet'}`
}
