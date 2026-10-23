// Small browser utilities used by React controls; no module-level DOM listeners.
export { episodeLabel, formatBytes, formatClock, formatSpeed } from './format.ts'
export { recall, remember } from './storage.ts'

export async function copy (text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    const area = document.createElement('textarea')
    area.value = text
    document.body.append(area)
    area.select()
    document.execCommand('copy')
    area.remove()
  }
}
export interface MenuOptions {
  title?: string
  className?: string
  ariaLabel?: string
  up?: boolean
  within?: (() => Element | null) | undefined
}
/** Geometry and document interactions belong to the mounted menu and are removed with it. */
export function attachMenu (
  box: HTMLDetailsElement,
  { up = false, within }: Pick<MenuOptions, 'up' | 'within'> = {}
): () => void {
  const summary = box.querySelector<HTMLElement>('summary')!
  const list = box.querySelector<HTMLElement>('.menu-items')!
  const timers = new Set<ReturnType<typeof setTimeout>>()
  const toggle = (): void => {
    summary.setAttribute('aria-expanded', String(box.open))
    if (!box.open) return
    for (const other of document.querySelectorAll<HTMLDetailsElement>('details.menu[open]')) { if (other !== box) other.open = false }
    list.style.left = ''
    list.style.maxHeight = ''
    const root = document.documentElement
    const bounds =
      within?.()?.getBoundingClientRect() ?? new DOMRect(0, 0, root.clientWidth, root.clientHeight)
    const button = box.getBoundingClientRect()
    const width = list.offsetWidth
    const gap = 4
    let left = button.left + width > bounds.right - gap ? button.width - width : 0
    left = Math.max(bounds.left + gap - button.left, Math.min(left, bounds.right - gap - button.left - width))
    list.style.left = `${left}px`
    if (up) list.style.maxHeight = `${Math.max(96, button.top - bounds.top - 2 * gap)}px`
  }
  const choose = (e: Event): void => {
    const item = (e.target as Element).closest('a, button')
    if (!item) return
    const timer = setTimeout(
      () => {
        timers.delete(timer)
        box.open = false
      },
      item.matches('button.copy') ? 700 : 0
    )
    timers.add(timer)
  }
  const outside = (e: Event): void => {
    if (box.open && !box.contains(e.target as Node)) box.open = false
  }
  const escape = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && box.open) {
      box.open = false
      summary.focus()
    }
  }
  box.addEventListener('toggle', toggle)
  list.addEventListener('click', choose, true)
  document.addEventListener('click', outside)
  document.addEventListener('keydown', escape)
  return () => {
    box.removeEventListener('toggle', toggle)
    list.removeEventListener('click', choose, true)
    document.removeEventListener('click', outside)
    document.removeEventListener('keydown', escape)
    for (const timer of timers) clearTimeout(timer)
  }
}
export function timeAgo (ms: number): string {
  const s = Math.max(0, (Date.now() - ms) / 1000)
  if (s < 90) return 'just now'
  if (s < 5400) return `${Math.round(s / 60)} min ago`
  if (s < 129600) return `${Math.round(s / 3600)} h ago`
  return `${Math.round(s / 86400)} days ago`
}
export function tint (text: string): string {
  let h = 0
  for (const ch of text) h = (h * 31 + (ch.codePointAt(0) ?? 0)) >>> 0
  return `tint-${(h % 6) + 1}`
}
export const count = (n: number, word: string): string => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`
export const shortHash = (infoHash: string): string => `${infoHash.slice(0, 8)}…`
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
