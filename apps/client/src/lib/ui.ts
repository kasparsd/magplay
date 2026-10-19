// Small helpers shared by every page: building DOM, formatting, copying.
import { formatBytes } from './format.ts'

/** A child for el() and fill(); null, undefined and false are skipped so `cond && node` works. */
export type Child = Node | string | null | undefined | false

/**
 * querySelector that assumes the element exists: pages query their own static markup.
 * Pages adopt the checked requireElement(selector, ctor) below as they convert.
 */
export const $ = <E extends Element = HTMLElement>(selector: string, root: ParentNode = document): E => root.querySelector(selector) as E

/** Query owned static markup and check its runtime element type before using it. */
export function requireElement<E extends Element> (selector: string, ctor: new () => E, root: ParentNode = document): E {
  const node = root.querySelector(selector)
  if (!(node instanceof ctor)) throw new Error(`Expected ${selector} to be a ${ctor.name}`)
  return node
}

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

export { episodeLabel, formatBytes, formatClock, formatSpeed } from './format.ts'

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

export interface MenuOptions {
  /** Tooltip for the button. */
  title?: string
  className?: string
  /** Accessible name, when the label is an icon. */
  ariaLabel?: string
  /** Open above the button, as the Player's chrome menus do. */
  up?: boolean
  /** The element the menu must stay inside (the Player's stage); the viewport when not given. */
  within?: (() => Element | null) | undefined
}

/**
 * A dropdown menu built on <details>: menu('More', [menuHeading('Whole torrent'), el('a', …), menuSeparator(), copyButton(…)]).
 * Closes on an outside click, Escape, or after an item is chosen; only one is open at a time.
 * It opens toward the side of the button that has room and is shifted and capped so it never leaves its bounds.
 */
export function menu (label: string | Node, items: Child[], { title = '', className = '', ariaLabel = '', up = false, within }: MenuOptions = {}): HTMLDetailsElement {
  const summary = el('summary', { title })
  summary.append(label)
  if (ariaLabel) summary.setAttribute('aria-label', ariaLabel)
  // A summary isn't announced as a button everywhere; say what it is and whether it is open
  summary.setAttribute('role', 'button')
  summary.setAttribute('aria-haspopup', 'menu')
  summary.setAttribute('aria-expanded', 'false')
  const list = el('div', { className: `menu-items${up ? ' up' : ''}` }, ...items)
  const box = el('details', { className: `menu ${className}`.trim() }, summary, list)
  box.addEventListener('toggle', () => {
    summary.setAttribute('aria-expanded', String(box.open))
    if (!box.open) return
    for (const other of document.querySelectorAll<HTMLDetailsElement>('details.menu[open]')) if (other !== box) other.open = false
    list.style.left = ''
    list.style.maxHeight = ''
    const root = document.documentElement
    const bounds = within?.()?.getBoundingClientRect() ?? new DOMRect(0, 0, root.clientWidth, root.clientHeight)
    const button = box.getBoundingClientRect()
    const width = list.offsetWidth
    const gap = 4
    // Left-aligned with the button when that fits, else right-aligned, then pushed back inside the bounds
    let left = button.left + width > bounds.right - gap ? button.width - width : 0
    left = Math.max(bounds.left + gap - button.left, Math.min(left, bounds.right - gap - button.left - width))
    list.style.left = `${left}px`
    if (up) list.style.maxHeight = `${Math.max(96, button.top - bounds.top - 2 * gap)}px`
  })
  list.addEventListener('click', e => {
    const item = (e.target as Element).closest('a, button')
    // Copy buttons say "Copied" first, so close a moment later
    if (item) setTimeout(() => { box.open = false }, item.matches('button.copy') ? 700 : 0)
  }, true) // capture: copy buttons stop the click from bubbling
  return box
}

/** A choice in a menu that works like a radio group (Subtitles, Audio, Speed). */
export function menuChoice (label: string, checked: boolean, onclick: () => void, { disabled = false, title = '' } = {}): HTMLButtonElement {
  const item = el('button', { type: 'button', className: 'choice', textContent: label, onclick, disabled, title })
  item.setAttribute('role', 'menuitemradio')
  item.setAttribute('aria-checked', String(checked))
  return item
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
  for (const ch of text) h = (h * 31 + (ch.codePointAt(0) ?? 0)) >>> 0
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
  playbackEffort?: 'direct' | 'remux' | 'transcode' | null | undefined
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
        r.playbackEffort === 'direct' && el('span', { className: 'badge good', textContent: 'likely direct', title: 'The title looks like 8-bit H.264 with AAC. Native playback still depends on the container and this browser; otherwise the server remuxes.' }),
        r.playbackEffort === 'remux' && el('span', { className: 'badge good', textContent: 'likely remux', title: 'H.264 video. A cheap pass can repackage the file or convert the audio. The video is not re-encoded.' }),
        r.playbackEffort === 'transcode' && el('span', { className: 'badge', textContent: 'needs transcode', title: 'The title\'s video codec has to be re-encoded. That stays off unless Convert unsupported video is enabled.' }),
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
