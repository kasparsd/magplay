// The right side of every page's top bar: a status button showing overall health, whose panel lists
// the checks worst first with their fixes, and a gear that links to Settings.
// Server checks come from GET /api/status (polled every 30 s while the tab is visible); browser checks (the connection test) are merged in here.
import { byLevel, overallLevel, problems } from '@magplay/api-contract'
import type { StatusCheck, StatusLevel, StatusResponse } from '@magplay/api-contract'
import { api } from './api.ts'
import { STORAGE_KEYS } from './preferences.ts'
import { connectionLevel, readConnection } from './speedtest.ts'
import { el, fill, formatSpeed, menu } from './ui.ts'

const POLL_MS = 30_000

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
    ...(level === 'warn' && { message: 'May struggle with high-bitrate video. Weak Wi-Fi?', action: { label: 'Test again', href } }),
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

const HEADLINES: Record<StatusLevel, string> = { ok: 'All good', warn: 'Needs attention', error: 'Something isn’t working', unknown: 'Not checked yet' }
const LEVEL_NAMES: Record<StatusLevel, string> = { ok: 'OK', warn: 'Warning', error: 'Problem', unknown: 'Not checked' }

const dot = (level: StatusLevel, extra = ''): HTMLSpanElement => el('span', { className: `status-dot lvl-${level} ${extra}`.trim(), title: LEVEL_NAMES[level] })

function summary (status: MergedStatus): string {
  const errors = status.checks.filter(c => c.level === 'error').length
  const warnings = status.checks.filter(c => c.level === 'warn').length
  if (errors && warnings) return `${errors} ${errors === 1 ? 'problem' : 'problems'}, ${warnings} ${warnings === 1 ? 'warning' : 'warnings'}`
  if (errors) return errors === 1 ? '1 check is failing' : `${errors} checks are failing`
  if (warnings) return warnings === 1 ? '1 check needs a look' : `${warnings} checks need a look`
  if (status.level === 'unknown') return 'Some checks haven’t run yet'
  return 'Every check passed'
}

/** The status button's accessible name carries the state: "Status: 2 problems". */
function buttonLabel (status: MergedStatus | null): string {
  if (!status) return 'Status: checking'
  const n = problems(status.checks).length
  if (n) return `Status: ${n} ${n === 1 ? 'problem' : 'problems'}`
  return `Status: ${status.level === 'ok' ? 'all good' : 'not checked yet'}`
}

const GEAR = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>'

function checkRow (c: StatusCheck): HTMLLIElement {
  const problem = c.level === 'warn' || c.level === 'error'
  return el('li', { className: `status-check lvl-${c.level}` },
    dot(c.level),
    el('div', { className: 'status-check-main' },
      el('div', { className: 'status-check-line' },
        el('span', { className: 'status-check-label', textContent: c.label }),
        c.value && el('span', { className: 'status-check-value', textContent: c.value })),
      problem && c.message && el('p', { className: 'status-check-message' }, c.message[0]!.toUpperCase() + c.message.slice(1), ' ',
        c.action && el('a', { href: c.action.href, textContent: `${c.action.label} →` })),
      !problem && c.level === 'unknown' && c.action && el('p', { className: 'status-check-message' }, el('a', { href: c.action.href, textContent: `${c.action.label} →` }))))
}

function renderPanel (panel: HTMLElement, status: MergedStatus | null): void {
  if (!status) {
    fill(panel, el('p', { className: 'status busy', textContent: 'Checking…' }))
    return
  }
  fill(panel,
    el('div', { className: 'status-head' },
      dot(status.level, 'large'),
      el('div', {},
        el('strong', { textContent: HEADLINES[status.level] }),
        el('p', { textContent: summary(status) }))),
    el('div', { className: 'status-section' },
      el('div', { className: 'menu-heading', textContent: 'Status' }),
      el('ul', { className: 'status-checks' }, ...status.checks.map(checkRow))),
    el('div', { className: 'status-foot' },
      el('a', { href: '/settings#debug', textContent: 'Debug details' })))
}

function renderButton (summaryEl: HTMLElement, status: MergedStatus | null): void {
  const level = status?.level ?? 'unknown'
  const n = status ? problems(status.checks).length : 0
  fill(summaryEl, dot(level), n > 0 && el('span', { className: 'status-count', textContent: String(n) }))
  summaryEl.setAttribute('aria-label', buttonLabel(status))
  summaryEl.title = buttonLabel(status)
}

/** A plain link to Settings, next to the status button. */
function settingsLink (): HTMLAnchorElement {
  const link = el('a', { href: '/settings', className: 'settings-link', title: 'Settings' })
  link.setAttribute('aria-label', 'Settings')
  if (location.pathname === '/settings') link.setAttribute('aria-current', 'page')
  link.innerHTML = GEAR
  return link
}

/** Adds the status button (with its panel) and the Settings gear to the page's top bar, once, and starts polling. */
export function mountStatusMenu (bar: Element | null = document.querySelector('header.topbar')): HTMLDetailsElement | null {
  if (!bar || bar.querySelector('.status-menu')) return null
  const panel = el('div', { className: 'status-panel' })
  const box = menu(el('span'), [panel], { className: 'status-menu' })
  const summaryEl = box.querySelector('summary')!
  summaryEl.className = 'status-button'
  bar.append(el('div', { className: 'topbar-end' }, box, settingsLink()))
  const render = (status: MergedStatus | null): void => {
    renderButton(summaryEl, status)
    renderPanel(panel, status)
  }
  render(null)
  listeners.add(render)
  box.addEventListener('toggle', () => {
    if (box.open) refreshStatus().catch(console.error)
  })

  let lastRefresh = 0
  const poll = (): void => {
    if (document.hidden || Date.now() - lastRefresh < 5000) return
    lastRefresh = Date.now()
    refreshStatus().catch(console.error)
  }
  poll()
  setInterval(poll, POLL_MS)
  document.addEventListener('visibilitychange', poll)
  window.addEventListener('focus', poll)
  // A connection test on the settings page (another tab) updates this one
  window.addEventListener('storage', e => { if (e.key === STORAGE_KEYS.connection) updateBrowserChecks() })
  return box
}
