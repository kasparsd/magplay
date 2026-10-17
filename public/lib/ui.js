// Small helpers shared by every page: building DOM, formatting, copying.
// Compatibility export for older callers; new code imports the DOM-free client.
export { api } from './api.js'

export const $ = (selector, root = document) => root.querySelector(selector)
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** el('a', { href, textContent }, ...children). Null, undefined and false children are skipped. */
export function el (tag, attrs = {}, ...children) {
  const node = Object.assign(document.createElement(tag), attrs)
  node.append(...children.filter(c => c != null && c !== false))
  return node
}

/** Replaces a node's children, skipping null/false (replaceChildren would print them as text). */
export const fill = (node, ...children) => node.replaceChildren(...children.filter(c => c != null && c !== false))

/** Sets a status line's text and look: kind is '', 'busy' (spinner) or 'error'. */
export function setStatus (node, text, kind = '') {
  node.textContent = text
  node.className = `status ${kind}`
}

export const formatBytes = n => n == null ? '' : n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.round(n / 1e6)} MB`
export const formatSpeed = n => n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB/s` : `${Math.round(n / 1e3)} KB/s`
export function formatClock (s) {
  s = Math.max(0, Math.floor(s || 0))
  const [h, m, sec] = [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60]
  return (h ? `${h}:${String(m).padStart(2, '0')}` : m) + ':' + String(sec).padStart(2, '0')
}
export const episodeLabel = f => f.episode == null ? '' : `S${String(f.season ?? 0).padStart(2, '0')}E${String(f.episode).padStart(2, '0')}`

export async function copy (text) {
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
export function copyButton (label, text, title = text) {
  const button = el('button', { type: 'button', className: 'copy', textContent: label, title })
  button.addEventListener('click', async e => {
    e.stopPropagation()
    await copy(text)
    button.textContent = 'Copied'
    setTimeout(() => { button.textContent = label }, 1500)
  })
  return button
}

/**
 * A dropdown menu built on <details>: menu('More', [menuHeading('Whole torrent'), el('a', …), menuSeparator(), copyButton(…)]).
 * Closes on an outside click, Escape, or after an item is chosen; only one is open at a time.
 */
export function menu (label, items, { title = '', className = '' } = {}) {
  const box = el('details', { className: `menu ${className}`.trim() },
    el('summary', { textContent: label, title }),
    el('div', { className: 'menu-items' }, ...items))
  box.addEventListener('toggle', () => {
    if (box.open) for (const other of document.querySelectorAll('details.menu[open]')) if (other !== box) other.open = false
  })
  box.querySelector('.menu-items').addEventListener('click', e => {
    const item = e.target.closest('a, button')
    // Copy buttons say "Copied" first, so close a moment later
    if (item) setTimeout(() => { box.open = false }, item.matches('button.copy') ? 700 : 0)
  }, true) // capture: copy buttons stop the click from bubbling
  return box
}
export const menuHeading = text => el('div', { className: 'menu-heading', textContent: text })
export const menuSeparator = () => el('hr')

document.addEventListener('click', e => {
  for (const open of document.querySelectorAll('details.menu[open]')) if (!open.contains(e.target)) open.open = false
})
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return
  for (const open of document.querySelectorAll('details.menu[open]')) {
    open.open = false
    open.querySelector('summary').focus()
  }
})

/** Per-browser memory (last episode played…). Storage can be blocked, so failures are ignored. */
export function recall (key) {
  try { return JSON.parse(localStorage.getItem(`magplay:${key}`)) } catch { return null }
}
export function remember (key, value) {
  try { localStorage.setItem(`magplay:${key}`, JSON.stringify(value)) } catch {}
}

/** "3 min ago", "2 h ago", "4 days ago". */
export function timeAgo (ms) {
  const s = Math.max(0, (Date.now() - ms) / 1000)
  if (s < 90) return 'just now'
  if (s < 5400) return `${Math.round(s / 60)} min ago`
  if (s < 129600) return `${Math.round(s / 3600)} h ago`
  return `${Math.round(s / 86400)} days ago`
}

/** One of six tile colours, picked from the text so a title always gets the same one. */
export function tint (text) {
  let h = 0
  for (const ch of String(text)) h = (h * 31 + ch.codePointAt(0)) >>> 0
  return `tint-${(h % 6) + 1}`
}

/** A plain title tile in place of a poster. */
export const posterTile = (title, extra = '') => el('div', { className: `poster ${tint(title)} ${extra}`.trim(), textContent: title, ariaHidden: 'true' })

/** One row in a list of releases: name (linking to its torrent page), badges, size and seeders. */
export function releaseRow (r, href) {
  return el('li', {},
    el('div', { className: 'main' },
      el('a', { href, className: 'title', textContent: r.name }),
      el('div', { className: 'badges' },
        r.episode && el('span', { className: 'badge note', textContent: r.episode }),
        ...(r.badges ?? []).map(b => el('span', { className: 'badge', textContent: b })),
        r.likelyDirect && el('span', { className: 'badge good', textContent: 'plays in browser' }))),
    el('span', { className: 'size' }, [formatBytes(r.size), r.seeders != null && `${r.seeders} seeders`].filter(Boolean).join(' · ')))
}
