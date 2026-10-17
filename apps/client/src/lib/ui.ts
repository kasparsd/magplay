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

/** One row in a list of releases: name (linking to its torrent page), badges, size and seeders. Used by every page. */
export interface ReleaseRowItem {
  name: string
  episode?: string | null
  /** A caution about the release, such as "Not a video". */
  warning?: string | null | undefined
  badges?: string[] | undefined
  likelyDirect?: boolean | undefined
  size?: number | null | undefined
  seeders?: number | null | undefined
}

export interface ReleaseRowOptions {
  /** Extra badges after the release's own, such as "best". */
  extra?: Child[]
  /** Facts before size and seeders on the meta line, such as "2 h ago". */
  meta?: Array<string | null | undefined | false>
  /** A muted line under the badges, such as where the result came from. */
  note?: string | null | undefined
}

export function releaseRow (r: ReleaseRowItem, href: string, { extra = [], meta = [], note }: ReleaseRowOptions = {}): HTMLLIElement {
  return el('li', {},
    el('div', { className: 'main' },
      el('a', { href, className: 'title', textContent: r.name }),
      el('div', { className: 'badges' },
        r.warning && el('span', { className: 'badge note', textContent: r.warning }),
        r.episode && el('span', { className: 'badge note', textContent: r.episode }),
        ...(r.badges ?? []).map(b => el('span', { className: 'badge', textContent: b })),
        r.likelyDirect && el('span', { className: 'badge good', textContent: 'plays in browser', title: 'H.264 with AAC or unknown audio: likely plays in any browser' }),
        ...extra),
      note && el('div', { className: 'meta', textContent: note })),
    el('span', { className: 'size' }, [...meta, formatBytes(r.size), r.seeders != null && count(r.seeders, 'seeder')].filter(Boolean).join(' · ')))
}

/** An error in a status line, with a Try again button that reruns `retry` on the page instead of reloading it. */
export function setError (node: HTMLElement, message: string, retry?: () => void): void {
  setStatus(node, message, 'error')
  if (retry) node.append(' ', el('button', { type: 'button', className: 'retry', textContent: 'Try again', onclick: retry }))
}

/** "dd8255ec…" for a heading or label that would otherwise be a 40-character infohash. */
export const shortHash = (infoHash: string): string => `${infoHash.slice(0, 8)}…`

// The last search, so the header search box keeps it on every page (sessionStorage: per tab, like Back)
export function lastSearch (): string {
  try { return sessionStorage.getItem('magplay:q') ?? '' } catch { return '' }
}
export function rememberSearch (q: string): void {
  try { sessionStorage.setItem('magplay:q', q) } catch {}
}
for (const input of document.querySelectorAll<HTMLInputElement>('.topsearch input[name="q"]')) if (!input.value) input.value = lastSearch()
