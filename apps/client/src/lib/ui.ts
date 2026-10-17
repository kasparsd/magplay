// Small helpers shared by every page: building DOM, formatting, copying.

/** A child for el() and fill(); null, undefined and false are skipped so `cond && node` works. */
export type Child = Node | string | null | undefined | false

/**
 * querySelector that assumes the element exists: pages query their own static markup.
 * Phase 5 replaces this with a checked requireElement(selector, ctor).
 */
export const $ = <E extends Element = HTMLElement>(selector: string, root: ParentNode = document): E => root.querySelector(selector) as E
export const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

const present = (c: Child): c is Node | string => c != null && c !== false

/** el('a', { href, textContent }, ...children). Null, undefined and false children are skipped. */
export function el<K extends keyof HTMLElementTagNameMap> (tag: K, attrs: Partial<HTMLElementTagNameMap[K]> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), attrs)
  node.append(...children.filter(present))
  return node
}

/** Replaces a node's children, skipping null/false (replaceChildren would print them as text). */
export const fill = (node: ParentNode, ...children: Child[]): void => node.replaceChildren(...children.filter(present))

export type StatusKind = '' | 'busy' | 'error'

/** Sets a status line's text and look: kind is '', 'busy' (spinner) or 'error'. */
export function setStatus (node: HTMLElement, text: string, kind: StatusKind = ''): void {
  node.textContent = text
  node.className = `status ${kind}`
}

export const formatBytes = (n: number | null | undefined): string => n == null ? '' : n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.round(n / 1e6)} MB`
export const formatSpeed = (n: number): string => n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB/s` : `${Math.round(n / 1e3)} KB/s`
export function formatClock (seconds: number | null | undefined): string {
  const s = Math.max(0, Math.floor(seconds || 0))
  const [h, m, sec] = [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60]
  return (h ? `${h}:${String(m).padStart(2, '0')}` : m) + ':' + String(sec).padStart(2, '0')
}
export const episodeLabel = (f: { season?: number | null, episode?: number | null }): string => f.episode == null ? '' : `S${String(f.season ?? 0).padStart(2, '0')}E${String(f.episode).padStart(2, '0')}`

export async function copy (text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text) // only available over HTTPS or on localhost
  } catch {
    const area = el('textarea', { value: text })
    document.body.append(area)
    area.select()
    document.execCommand('copy')
    area.remove()
  }
}

/** A small button that copies `text` and briefly says so. */
export function copyButton (label: string, text: string, title = text): HTMLButtonElement {
  const button = el('button', { type: 'button', className: 'copy', textContent: label, title })
  button.addEventListener('click', e => {
    e.stopPropagation()
    copy(text).then(() => {
      button.textContent = 'Copied'
      setTimeout(() => { button.textContent = label }, 1500)
    }, (err: unknown) => console.error(err))
  })
  return button
}

/**
 * A dropdown menu built on <details>: menu('More', [menuHeading('Whole torrent'), el('a', …), menuSeparator(), copyButton(…)]).
 * Closes on an outside click, Escape, or after an item is chosen; only one is open at a time.
 */
export function menu (label: string, items: Child[], { title = '', className = '' } = {}): HTMLDetailsElement {
  const box = el('details', { className: `menu ${className}`.trim() },
    el('summary', { textContent: label, title }),
    el('div', { className: 'menu-items' }, ...items))
  box.addEventListener('toggle', () => {
    if (!box.open) return
    for (const other of document.querySelectorAll<HTMLDetailsElement>('details.menu[open]')) if (other !== box) other.open = false
    // Open toward the side of the button that has room, so the items aren't clipped by the viewport
    const items = $('.menu-items', box)
    const { left, right } = box.getBoundingClientRect()
    items.classList.toggle('end', document.documentElement.clientWidth - left < items.offsetWidth && right > document.documentElement.clientWidth - left)
  })
  $('.menu-items', box).addEventListener('click', e => {
    const item = (e.target as Element).closest('a, button')
    // Copy buttons say "Copied" first, so close a moment later
    if (item) setTimeout(() => { box.open = false }, item.matches('button.copy') ? 700 : 0)
  }, true) // capture: copy buttons stop the click from bubbling
  return box
}
export const menuHeading = (text: string): HTMLDivElement => el('div', { className: 'menu-heading', textContent: text })
export const menuSeparator = (): HTMLHRElement => el('hr')

document.addEventListener('click', e => {
  for (const open of document.querySelectorAll<HTMLDetailsElement>('details.menu[open]')) if (!open.contains(e.target as Node)) open.open = false
})
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return
  for (const open of document.querySelectorAll<HTMLDetailsElement>('details.menu[open]')) {
    open.open = false
    $('summary', open).focus()
  }
})

/** Per-browser memory (last episode played…). Storage can be blocked, so failures are ignored. */
export function recall (key: string): unknown {
  try { return JSON.parse(localStorage.getItem(`magplay:${key}`) ?? 'null') } catch { return null }
}
export function remember (key: string, value: unknown): void {
  try { localStorage.setItem(`magplay:${key}`, JSON.stringify(value)) } catch {}
}

/** "3 min ago", "2 h ago", "4 days ago". */
export function timeAgo (ms: number): string {
  const s = Math.max(0, (Date.now() - ms) / 1000)
  if (s < 90) return 'just now'
  if (s < 5400) return `${Math.round(s / 60)} min ago`
  if (s < 129600) return `${Math.round(s / 3600)} h ago`
  return `${Math.round(s / 86400)} days ago`
}

/** One of six tile colours, picked from the text so a title always gets the same one. */
export function tint (text: string): string {
  let h = 0
  for (const ch of String(text)) h = (h * 31 + (ch.codePointAt(0) ?? 0)) >>> 0
  return `tint-${(h % 6) + 1}`
}

/** A plain title tile in place of a poster. */
export const posterTile = (title: string, extra = ''): HTMLDivElement => el('div', { className: `poster ${tint(title)} ${extra}`.trim(), textContent: title, ariaHidden: 'true' })

/** `1 seeder`, `2 seeders`. */
export const count = (n: number, word: string): string => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`

type HealthLevel = 'ok' | 'warn' | 'error' | 'unknown'
type StatusCheck = { id: string, label: string, level: HealthLevel, value?: string, message?: string, action?: string }
type StatusEvent = { at: number, checkId: string, level: HealthLevel, message: string }
type StatusResponse = { level: HealthLevel, checks: StatusCheck[], events: StatusEvent[] }

/** Add the shared status pin to a page's top bar and keep it fresh while visible. */
export function installStatusPin (): void {
  const bar = document.querySelector('.topbar')
  if (!bar || bar.querySelector('.status-menu')) return
  const panel = el('div', { className: 'status-panel' })
  const box = menu('Status', [panel], { className: 'button status-menu' })
  const summary = $('summary', box)
  const lastSeen = Number(recall('status-last-seen')) || 0
  let seen = lastSeen
  let latest: StatusResponse | null = null

  const render = () => {
    if (!latest) return
    const { level, checks, events } = latest
    const problems = checks.filter(check => check.level === 'warn' || check.level === 'error')
    const label = level === 'ok' ? 'All good' : level === 'unknown' ? 'Checking status' : level === 'warn' ? 'Needs attention' : "Something isn't working"
    summary.className = `status-pin ${level}`
    summary.textContent = ''
    summary.setAttribute('aria-label', problems.length ? `Status: ${problems.length} problem${problems.length === 1 ? '' : 's'}` : `Status: ${label}`)
    summary.append(el('span', { className: 'status-dot', ariaHidden: 'true' }))
    if (problems.length) summary.append(el('span', { className: 'status-count', textContent: String(problems.length) }))
    const unread = events.filter(event => event.at > seen)
    fill(panel,
      el('p', { className: 'status-headline', textContent: label }),
      el('p', { className: 'status-summary', textContent: level === 'ok' ? 'Required services are connected.' : level === 'unknown' ? 'Status checks are still running.' : `${problems.length} item${problems.length === 1 ? '' : 's'} need attention.` }),
      el('h2', { textContent: 'Status' }),
      el('ul', { className: 'status-checks' }, ...checks.map(check => el('li', { className: `status-check ${check.level}` },
        el('span', { className: 'check-dot', ariaHidden: 'true' }),
        el('span', { className: 'check-label', textContent: check.label }),
        el('span', { className: 'check-value', textContent: check.value ?? '' }),
        check.message && el('span', { className: 'check-message', textContent: check.message }),
        check.action && el('a', { href: check.action, textContent: 'Fix' })))),
      events.length ? el('section', { className: 'status-recent' }, el('h2', { textContent: unread.length ? `Recent (${unread.length} new)` : 'Recent' }), el('ul', {}, ...events.slice(0, 5).map(event => el('li', { textContent: event.message })))) : null,
      el('p', { className: 'status-footer' }, el('a', { href: '/settings', textContent: 'Settings' }), ' · ', el('a', { href: '/settings#debug', textContent: 'Debug' })))
  }
  const load = async () => {
    if (document.visibilityState !== 'visible') return
    try {
      latest = await (await fetch('/api/status', { cache: 'no-store' })).json() as StatusResponse
      render()
    } catch { /* The ring stays unknown until the NAS is reachable again. */ }
  }
  box.addEventListener('toggle', () => {
    if (box.open && latest) {
      seen = Date.now()
      remember('status-last-seen', seen)
      render()
    }
  })
  const settings = el('a', { className: 'settings-shortcut', href: '/settings', title: 'Settings', ariaLabel: 'Settings' })
  if (location.pathname === '/settings') settings.setAttribute('aria-current', 'page')
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  icon.setAttribute('viewBox', '0 0 24 24')
  icon.setAttribute('aria-hidden', 'true')
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  path.setAttribute('d', 'M12 8.5A3.5 3.5 0 1 0 12 15.5 3.5 3.5 0 0 0 12 8.5m0-6 1.1 2.6 2.8.3.8 2.7 2.4 1.5-1 2.6 1 2.6-2.4 1.5-.8 2.7-2.8.3L12 21.5l-1.1-2.6-2.8-.3-.8-2.7-2.4-1.5 1-2.6-1-2.6 2.4-1.5.8-2.7 2.8-.3L12 2.5Z')
  icon.append(path)
  settings.append(icon)
  bar.append(box, settings)
  load().catch(() => {})
  setInterval(() => { load().catch(() => {}) }, 30_000)
  addEventListener('focus', () => { load().catch(() => {}) })
}

// Every client entry imports this module after its static top bar has been parsed.
installStatusPin()

/** One row in a list of releases: name (linking to its torrent page), badges, size and seeders. */
export interface ReleaseRowItem {
  name: string
  episode?: string | null
  badges?: string[] | undefined
  likelyDirect?: boolean | undefined
  size?: number | null | undefined
  seeders?: number | null | undefined
}

export function releaseRow (r: ReleaseRowItem, href: string): HTMLLIElement {
  return el('li', {},
    el('div', { className: 'main' },
      el('a', { href, className: 'title', textContent: r.name }),
      el('div', { className: 'badges' },
        r.episode && el('span', { className: 'badge note', textContent: r.episode }),
        ...(r.badges ?? []).map(b => el('span', { className: 'badge', textContent: b })),
        r.likelyDirect && el('span', { className: 'badge good', textContent: 'plays in browser' }))),
    el('span', { className: 'size' }, [formatBytes(r.size), r.seeders != null && count(r.seeders, 'seeder')].filter(Boolean).join(' · ')))
}
