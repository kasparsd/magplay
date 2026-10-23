// Overall health for the top bar's status menu (components/StatusMenu.tsx) and the Settings page: server checks from
// GET /api/status, with the browser's own checks (the connection test) merged in. The ['status'] query polls it.
import { byLevel, overallLevel, problems } from '@magplay/api-contract'
import type { StatusCheck, StatusLevel, StatusResponse } from '@magplay/api-contract'
import { api } from './api.ts'
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

let current: MergedStatus | null = null
let lastServer: StatusResponse | null = null
const listeners = new Set<(status: MergedStatus) => void>()

function merge (server: StatusResponse | null): MergedStatus {
  const checks = [...(server?.checks ?? []), connectionCheck()]
  if (!server) checks.unshift({ id: 'server', label: 'magplay server', required: true, level: 'error', message: 'The server didn’t answer. Is it running?' })
  return { level: overallLevel(checks), checks: checks.sort(byLevel), reachable: !!server }
}

let inflight: Promise<MergedStatus> | null = null
/** Fetches /api/status now (sharing a request already in flight) and tells every listener. */
export function refreshStatus (): Promise<MergedStatus> {
  inflight ??= api<StatusResponse>('/api/status', { cache: 'no-store' })
    .then(server => { lastServer = server }, () => { lastServer = null })
    .then(publish)
    .finally(() => { inflight = null })
  return inflight
}

function publish (): MergedStatus {
  const status = merge(lastServer)
  current = status
  for (const listener of listeners) listener(status)
  return status
}

/** Re-merges browser checks without asking the server: after a connection test. */
export const updateBrowserChecks = (): void => { if (current) publish() }

/** Calls `listener` with every status update (and now, if one is known). The settings page uses this for its nav dots. */
export function onStatus (listener: (status: MergedStatus) => void): void {
  listeners.add(listener)
  if (current) listener(current)
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
