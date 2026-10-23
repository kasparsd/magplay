// The settings page, /settings#<section>: a loop over the settings schema, one control per entry.
// Server settings collect in a save bar and are saved together; browser settings apply as they change.
import { SECTIONS, SERVER_CONVERSION_KEY, SETTINGS, isMaskedSecret, isValueDef, redactDeep, validate } from '@magplay/api-contract'
import type { DebugInfo, ListItem, SectionId, SettingDef, SettingMeta, SettingsErrorResponse, SettingsResponse, StatusCheck, StatusLevel, StatusResponse, ValueDef } from '@magplay/api-contract'
import { api, ApiError } from './lib/api.ts'
import { fillReadout, optionalNote, renderControl } from './lib/controls.ts'
import type { ControlContext, ReadoutValue } from './lib/controls.ts'
import { createCache, poll, sessionStore, takeLatest } from './lib/resource.ts'
import { presentSetting } from './lib/setting-rules.ts'
import { readPreferences, setPreference } from './lib/preferences.ts'
import type { PreferenceKey, Preferences } from './lib/preferences.ts'
import { connectionLevel, connectionWarning, measureConnection, readConnection, saveConnection, SLOW_BYTES_PER_SEC, SLOW_LATENCY_MS } from './lib/speedtest.ts'
import { onStatus, refreshStatus, updateBrowserChecks } from './lib/status-menu.ts'
import type { MergedStatus } from './lib/status-menu.ts'
import './lib/topbar.ts'
import { $, copy, el, fill, formatSpeed, setStatus, timeAgo } from './lib/ui.ts'
import type { Child } from './lib/ui.ts'

const body = $('#settings-body')
const saveBar = $('#savebar')

let saved: SettingsResponse | null = null
/** Unsaved server values by key. */
let draft: Record<string, unknown> = {}
let prefs: Preferences = readPreferences()
let debug: DebugInfo | null = null
let status: MergedStatus | null = null
/** Per-field error slots and readout boxes, so edits update in place without re-rendering (and losing focus). */
const errorSlots = new Map<string, HTMLElement>()
const readouts = new Map<string, HTMLElement>()
/** Results of Test buttons, by source item id, until the next status poll. */
const tested = new Map<string, StatusCheck>()

/** True from PATCH to its answer: editing is locked, and refreshes wait so they can't overwrite the save. */
let saving = false
/** Settings reads; a save or a newer read cancels the one in flight. */
const beginRead = takeLatest()

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

// ---- Readouts and actions the schema names; everything else is generic ----

const GB = 1024 ** 3
const gb = (n: number): string => `${(n / GB).toFixed(1)} GB`
/** Sizes below a gigabyte read in MB, so a 64 MB cache isn't "0.1 GB". */
const size = (n: number): string => n < GB ? `${Math.round(n / 1024 ** 2)} MB` : gb(n)
function uptime (s: number): string {
  const d = Math.floor(s / 86400)
  const h = Math.floor(s / 3600) % 24
  const m = Math.floor(s / 60) % 60
  return d ? `${d} d ${h} h` : h ? `${h} h ${m} min` : `${m} min`
}

let logLevel: 'debug' | 'info' | 'warn' | 'error' = 'info'
const LOG_ORDER = ['debug', 'info', 'warn', 'error'] as const

function logView (): HTMLElement {
  const filter = el('div', { className: 'seg' })
  filter.setAttribute('role', 'radiogroup')
  filter.setAttribute('aria-label', 'Lowest log level shown')
  for (const level of LOG_ORDER) {
    const input = el('input', { type: 'radio', name: 'log-level', value: level, checked: level === logLevel })
    input.addEventListener('change', () => { logLevel = level; refreshReadout('debug.log', true) })
    filter.append(el('label', {}, input, el('span', { textContent: level })))
  }
  const lines = (debug?.log ?? []).filter(l => LOG_ORDER.indexOf(l.level) >= LOG_ORDER.indexOf(logLevel)).slice(-200)
  const pre = el('div', { className: 'log', tabIndex: 0 },
    ...(lines.length
      ? lines.map(l => el('div', { className: `log-line lvl-${l.level}` },
        el('time', { textContent: new Date(l.time).toLocaleTimeString([], { hour12: false }) }),
        el('span', { className: 'log-level', textContent: l.level }),
        el('details', {}, el('summary', { textContent: l.msg !== l.event ? l.msg : l.event.replace(/[._-]+/g, ' ').replace(/^./, c => c.toUpperCase()) }), el('pre', { textContent: JSON.stringify(l, null, 2) }))))
      : [el('span', { className: 'muted', textContent: debug ? 'No log entries at this level.' : 'Loading…' })]))
  return el('div', {}, el('p', { className: 'muted', textContent: `Server log level: ${debug?.logging.level ?? '…'} · Dropped entries: ${debug?.logging.dropped ?? 0}. Filter the recorded entries below.` }), filter, pre)
}

function infoList (cells: Array<[string, ReadoutValue]>): HTMLElement {
  return el('dl', { className: 'readout-list' }, ...cells.map(([label, value]) => {
    const dd = el('dd')
    fillReadout(dd, value)
    return el('div', {}, el('dt', { textContent: label }), dd)
  }))
}

const READOUTS: Record<string, () => ReadoutValue> = {
  'connection.result': () => {
    const r = readConnection()
    if (!r) return 'No speed test results yet.'
    const level = connectionLevel(r)
    return el('div', { className: 'speed' },
      el('p', { className: 'speed-numbers' },
        el('strong', { textContent: formatSpeed(r.downBytesPerSec) }), el('span', { textContent: ' download ' }),
        el('strong', { textContent: `${Math.round(r.latencyMs)} ms` }), el('span', { textContent: ' latency ' }),
        el('span', { className: 'muted', textContent: `tested ${timeAgo(r.at)}` })),
      el('p', {}, el('span', { className: `status-dot lvl-${level}` }), ' ',
        level === 'warn'
          ? connectionWarning(r)
          : level === 'ok' ? `At least ${formatSpeed(SLOW_BYTES_PER_SEC)} download and no more than ${SLOW_LATENCY_MS} ms latency.` : 'These results are over a week old. Run the test again.'))
  },
  'cache.usage': () => {
    const disk = debug?.disk
    if (!disk) return debug ? 'Can’t read the cache folder.' : 'Loading…'
    // GB here are the same binary gigabytes the limit settings use
    return { text: `Torrent cache: ${gb(disk.cacheBytes)} / ${gb(disk.cacheMaxBytes)} · Free disk space: ${gb(disk.free)}`, fraction: disk.cacheBytes / disk.cacheMaxBytes }
  },
  'debug.server': () => debug
    ? infoList([['Version', debug.version], ['Uptime', uptime(debug.uptimeS)], ['Node', debug.node], ['ffmpeg', debug.ffmpeg ?? 'not installed'], ['Conversion', debug.serverConversion ? 'on the server (ffmpeg)' : 'in the browser when it can, otherwise in Node; nothing is re-encoded'], ['Encoders', (debug.encoders ?? []).join(', ') || 'none'], ['Transcode encoder', debug.transcodeEncoder ?? 'auto']])
    : 'Loading…',
  'debug.resources': () => {
    if (!debug) return 'Loading…'
    const resources = debug.resources
    const capacity = new Set(['conversions', 'torrentLoads', 'torrents', 'probes', 'subtitles'])
    const resourceGrid = (active: boolean): HTMLElement => infoList(resources.filter(r => capacity.has(r.id) === active).map(r => [r.label, r.unit === 'bytes'
      ? { text: `${size(r.used)} of ${size(r.limit)}`, fraction: r.used / r.limit }
      : r.limit ? { text: `${r.used} of ${r.limit}`, fraction: r.used / r.limit } : String(r.used)]))
    return el('div', { className: 'resource-groups' },
      el('details', { id: 'debug-capacity' }, el('summary', { textContent: 'Active jobs and limits' }), resourceGrid(true)),
      el('details', { id: 'debug-caches' }, el('summary', { textContent: 'Storage and caches' }), resourceGrid(false)))
  },
  'debug.log': logView,
}

const ACTIONS: Record<string, () => Promise<string | undefined>> = {
  'connection.test': async () => {
    const result = await measureConnection()
    saveConnection(result)
    refreshReadout('connection.result')
    updateBrowserChecks()
    return undefined
  },
  'debug.diagnostics': async () => {
    const [info, settings, statusNow] = await Promise.all([
      api<DebugInfo>('/api/debug'), api<SettingsResponse>('/api/settings'), api<StatusResponse>('/api/status'),
    ])
    // Settings come with secret fields masked; redactDeep also removes keys someone put in a URL's query string or userinfo
    await copy(JSON.stringify(redactDeep({ at: new Date().toISOString(), userAgent: navigator.userAgent, debug: info, settings, preferences: prefs, status: statusNow }), null, 2))
    return 'Copied'
  },
  'debug.clearHls': async () => {
    const { stopped } = await api<{ stopped: number }>('/api/debug/clear-hls', { method: 'POST' })
    await loadDebug()
    return stopped ? `Stopped ${stopped} conversion${stopped === 1 ? '' : 's'}` : 'Cleared'
  },
}

function refreshReadout (key: string, force = false): void {
  const box = readouts.get(key)
  const read = READOUTS[key]
  // Keep an investigation readable while the normal background poll continues.
  if (!force && key === 'debug.log' && box?.querySelector('details[open]')) return
  if (box && read) {
    // Keep resource disclosures and keyboard focus stable while their numbers update.
    if (key === 'debug.resources' && box.querySelector('.resource-groups')) {
      const next = read()
      if (next instanceof HTMLElement) {
        for (const group of box.querySelectorAll('details')) {
          const current = group.querySelector('.readout-list')
          const updated = next.querySelector(`#${group.id} .readout-list`)
          if (current && updated) current.replaceChildren(...updated.childNodes)
        }
        return
      }
    }
    fillReadout(box, read())
  }
}

async function loadDebug (): Promise<void> {
  try {
    debug = await api<DebugInfo>('/api/debug')
  } catch {
    return
  }
  for (const key of ['cache.usage', 'debug.server', 'debug.resources', 'debug.log']) refreshReadout(key)
  syncPresentation() // the transcode settings depend on whether this server has ffmpeg
}

// ---- Rows ----

const metaOf = (key: string): SettingMeta | undefined => saved?.meta[key]
const serverValue = (key: string): unknown => key in draft ? draft[key] : saved?.values[key]

/** Only when an env var actually sets the value: then the field is read-only and names the variable. */
function envNote (def: SettingDef, meta: SettingMeta | undefined): Child {
  if (def.scope !== 'server' || def.type === 'list' || meta?.source !== 'env') return null // locked list items say so themselves
  return el('p', { className: 'env-note' }, 'Set by ', el('code', { textContent: meta.env ?? def.env?.[0] ?? '' }), '. Change this environment variable to edit the setting.')
}

/** Source items get their live status and a Test button that checks the unsaved values. */
function sourceExtras (item: ListItem): Child[] {
  const check = tested.get(item.id) ?? status?.checks.find(c => c.id === `source:${item.id}`)
  const indicator = el('span', { className: 'source-status' })
  const show = (c: Pick<StatusCheck, 'level' | 'value' | 'message'> | undefined): void => {
    indicator.title = c?.message ?? ''
    if (!c) return fill(indicator)
    const word = c.level === 'ok' ? 'Working' : c.level === 'unknown' ? 'Checking' : 'Failed'
    fill(indicator, el('span', { className: `status-dot lvl-${c.level}` }), [word, c.level === 'ok' && c.value].filter(Boolean).join(' · '))
  }
  show(check)
  const message = el('span', { className: 'sr-only', role: 'status' })
  const test = el('button', { type: 'button', className: 'button', textContent: 'Test' })
  test.setAttribute('aria-label', `Test ${typeof item.url === 'string' && item.url ? item.url : 'source'}`)
  test.addEventListener('click', () => {
    const current = ((serverValue('sources') as ListItem[] | undefined) ?? []).find(i => i.id === item.id) ?? metaOf('sources')?.locked?.find(i => i.id === item.id) ?? item
    test.disabled = true
    show({ level: 'unknown' })
    api<StatusCheck>('/api/settings/test', { json: { key: 'sources', item: current } }).then(result => {
      tested.set(item.id, { ...result, id: item.id, label: '', required: true })
      show(result)
      message.textContent = result.level === 'ok' ? 'Working' : result.message ?? 'Failed'
      const slot = errorSlots.get('sources')
      if (slot) slot.textContent = result.level === 'ok' ? '' : result.message ?? ''
    }, (err: unknown) => {
      show({ level: 'error', message: err instanceof Error ? err.message : String(err) })
    }).finally(() => { test.disabled = false })
  })
  return [indicator, test, message]
}

function row (def: SettingDef): HTMLElement {
  const id = `setting-${def.key.replace(/\./g, '-')}`
  const meta = def.scope === 'server' ? metaOf(def.key) : undefined
  const locked = meta?.source === 'env' && def.type !== 'list'
  const error = el('p', { className: 'field-error', role: 'alert' })
  errorSlots.set(def.key, error)
  const value = def.scope === 'server' ? serverValue(def.key) : isValueDef(def) ? prefs[def.key as PreferenceKey] : undefined

  const ctx: ControlContext = { id, label: def.label, disabled: locked }
  if (def.type === 'action') ctx.run = ACTIONS[def.key] ?? (() => Promise.resolve('Not available'))
  if (def.type === 'readout') ctx.readout = READOUTS[def.key] ?? (() => '')
  if (def.type === 'list' && meta?.locked) ctx.locked = meta.locked
  if (def.key === 'sources' && def.type === 'list') {
    ctx.itemExtras = sourceExtras
    ctx.startWithOne = true // with no sources, the form to add one is already open
  }
  if (isValueDef(def)) {
    ctx.onChange = def.scope === 'server'
      ? (next, committed) => editServer(def, next, committed)
      : (next) => {
          if (setPreference(def.key as PreferenceKey, next as never)) {
            prefs = readPreferences()
            error.textContent = ''
          } else {
            error.textContent = 'That value isn’t allowed.'
          }
        }
  }
  const control = renderControl(def, value, ctx)
  if (def.type === 'readout') readouts.set(def.key, control)

  const wide = def.type === 'list' || (def.type === 'readout' && (def.key.startsWith('debug.') || def.key === 'connection.result'))
  const head = el('div', { className: 'row-text' },
    // Buttons and lists keep their own names, so only single value controls get a <label for>
    !(wide && def.type === 'readout') && (isValueDef(def) && def.type !== 'list'
      ? el('label', { className: 'row-label', htmlFor: id }, def.label, optionalNote(def))
      : el('span', { className: 'row-label' }, def.label, optionalNote(def))),
    def.help && el('p', { className: 'help', textContent: def.help }),
    envNote(def, meta))
  return el('div', { className: `row${wide ? ' wide' : ''}`, id: `row-${id}` },
    head.childElementCount ? head : null,
    el('div', { className: 'row-control' }, control),
    error)
}

function editServer (def: ValueDef, next: unknown, committed: boolean): void {
  const before = saved?.values[def.key]
  if (same(next, before)) delete draft[def.key]
  else draft[def.key] = next
  const slot = errorSlots.get(def.key)
  if (slot && committed) {
    // Masked secrets aren't checked here: the server fills them in
    const result = isMaskedSecret(next) ? { ok: true as const } : validate(def, next)
    slot.textContent = result.ok ? '' : `${def.label} ${result.error}`
  }
  renderSaveBar()
  syncPresentation()
}

/** Apply schema dependencies to existing controls so edits keep focus and values. */
function syncPresentation (): void {
  for (const def of SETTINGS) {
    if (!def.rules?.length) continue
    const row = document.getElementById(`row-setting-${def.key.replace(/\./g, '-')}`)
    if (!row) continue
    const presented = presentSetting(def, key => key === SERVER_CONVERSION_KEY ? debug?.serverConversion ?? true : serverValue(key))
    row.hidden = !!presented.hidden
    row.classList.toggle('inactive', !!presented.disabled)
    const disabled = !!presented.disabled || metaOf(def.key)?.source === 'env'
    for (const input of row.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('input, select, button')) input.disabled = disabled
    const help = row.querySelector('.help')
    if (help) help.textContent = presented.help ?? ''
  }
}

// ---- Sections ----

function cards (defs: SettingDef[]): HTMLElement[] {
  const groups = new Map<string, SettingDef[]>()
  for (const def of defs) {
    const name = def.group ?? ''
    groups.set(name, [...(groups.get(name) ?? []), def])
  }
  return [...groups].map(([name, list]) => el('div', { className: 'card' },
    name && el('div', { className: 'card-head' }, el('h3', { textContent: name })),
    ...list.map(row)))
}

/**
 * One section of the page, rendered from SECTIONS in order. Each is a self-contained <section> with its
 * own id (the #sources deep link) and heading, so the list can later become top tabs without a rewrite.
 */
function renderSection (id: SectionId): HTMLElement {
  const section = SECTIONS.find(s => s.id === id)!
  const defs = SETTINGS.filter(d => d.section === id && !d.hidden)
  const head = el('div', { className: 'section-head' },
    // No id on the status slot: one stylesheet serves every page, so a generated id here
    // could collide with a page's own styled id (#playback-status is the Player's wait overlay).
    el('h2', { id: `${id}-title` }, section.label, el('span', { className: 'section-status' })),
    el('p', { className: 'intro', textContent: section.intro }))
  const parts: Child[] = [head]
  const stored = defs.filter(isValueDef)
  if (stored.length && stored.every(d => d.scope === 'server' && metaOf(d.key)?.source === 'env' && d.type !== 'list')) {
    parts.push(el('p', { className: 'muted', textContent: 'These settings are controlled by environment variables.' }))
  }
  parts.push(...cards(defs))
  const box = el('section', { id, className: 'settings-section' }, ...parts)
  box.setAttribute('aria-labelledby', `${id}-title`)
  return box
}

function sectionLevel (id: SectionId): StatusLevel | null {
  const levels = (status?.checks ?? []).filter(c => c.action?.href === `/settings#${id}` && (c.level === 'warn' || c.level === 'error')).map(c => c.level)
  return levels.includes('error') ? 'error' : levels.includes('warn') ? 'warn' : null
}

/** A dot next to the heading of a section with a failing check. */
function renderSectionStatus (): void {
  for (const s of SECTIONS) {
    const slot = document.getElementById(s.id)?.querySelector('.section-status')
    const level = sectionLevel(s.id)
    if (slot) fill(slot, level && el('span', { className: `status-dot lvl-${level}`, title: level === 'error' ? 'Has a problem' : 'Needs attention' }))
  }
}

/** "Saved: search timeout" for a few seconds after a save, in the same bar. */
let savedNote: { text: string, expiresAt: number } | null = null
let savedTimer: ReturnType<typeof setTimeout> | null = null

function clearSavedNote (): void {
  if (savedTimer !== null) clearTimeout(savedTimer)
  savedTimer = null
  savedNote = null
}

function renderSaveBar (): void {
  const n = Object.keys(draft).length
  if (savedNote && (n || Date.now() >= savedNote.expiresAt)) clearSavedNote()
  saveBar.hidden = n === 0 && !savedNote
  saveBar.classList.toggle('saved', !n && !!savedNote)
  $('#savebar-count').textContent = savedNote && !n ? savedNote.text : `${n} unsaved ${n === 1 ? 'change' : 'changes'}`
}

function noteSaved (keys: string[]): void {
  clearSavedNote()
  const names = keys.map(key => SETTINGS.find(d => d.key === key)?.label.toLowerCase() ?? key)
  savedNote = { text: `Saved: ${names.join(', ')}`, expiresAt: Date.now() + 4000 }
  savedTimer = setTimeout(() => { renderSaveBar() }, 4000)
}

function render (): void {
  errorSlots.clear()
  readouts.clear()
  fill(body, ...SECTIONS.map(s => renderSection(s.id)))
  renderSectionStatus()
  renderSaveBar()
  syncPresentation()
  if (observer) watchLiveSections()
}

/** Scrolls to the section the hash names (#debug), once it has been rendered. */
function scrollToHash (): void {
  const target = location.hash && document.getElementById(location.hash.slice(1))
  if (target) target.scrollIntoView()
}

/** Disables every enabled control in the page and the Discard button; the returned function undoes it. */
function lockEditing (): () => void {
  const controls = [...body.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement>('input, select, textarea, button'), $<HTMLButtonElement>('#savebar-discard')]
    .filter(control => !control.disabled)
  for (const control of controls) control.disabled = true
  return () => { for (const control of controls) if (control.isConnected) control.disabled = false }
}

async function save (): Promise<void> {
  const button = $<HTMLButtonElement>('#savebar-save')
  button.disabled = true
  saving = true
  beginRead() // a read that started before the PATCH would show the old values
  const unlock = lockEditing()
  setStatus($('#savebar-status'), 'Saving…', 'busy')
  try {
    const res = await fetch('/api/settings', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(draft) })
    const out = await res.json() as SettingsResponse | SettingsErrorResponse
    if (!res.ok) {
      const failed = 'fields' in out ? out.fields : {}
      for (const [key, message] of Object.entries(failed)) {
        const slot = errorSlots.get(key)
        if (slot) slot.textContent = message
      }
      // Show the first failing field
      const first = Object.keys(failed)[0]
      if (first) errorSlots.get(first)?.closest('.row')?.scrollIntoView({ block: 'center' })
      setStatus($('#savebar-status'), 'error' in out ? out.error : `HTTP ${res.status}`, 'error')
      return
    }
    saved = out as SettingsResponse
    // These rebuild the server's discovery state, including private download-link ids that cached results point at
    if ('sources' in draft || 'search.timeoutS' in draft) createCache(sessionStore()).invalidate('search:')
    noteSaved(Object.keys(draft))
    draft = {}
    tested.clear()
    setStatus($('#savebar-status'), '')
    render()
    refreshStatus().catch(console.error)
    loadDebug().catch(console.error)
  } catch (err) {
    setStatus($('#savebar-status'), err instanceof Error ? err.message : 'Saving failed', 'error')
  } finally {
    saving = false
    unlock()
    button.disabled = false
  }
}

/**
 * Reads the settings again when the tab comes back, in case another tab or the API changed them. Unedited fields show
 * the new values; drafts stay as typed and Discard returns to the new values. A field being edited keeps its node.
 */
async function refresh (): Promise<void> {
  if (!saved || saving) return
  const signal = beginRead()
  const next = await api<SettingsResponse>('/api/settings', { cache: 'no-store', signal }).catch(() => null)
  if (!next || signal.aborted || saving) return
  const before = saved
  saved = next
  for (const def of SETTINGS) {
    if (def.scope !== 'server' || !isValueDef(def) || def.key in draft) continue
    if (same(before.values[def.key], next.values[def.key]) && same(before.meta[def.key], next.meta[def.key])) continue
    const old = document.getElementById(`row-setting-${def.key.replace(/\./g, '-')}`)
    if (old && !old.contains(document.activeElement)) old.replaceWith(row(def))
  }
  syncPresentation()
  renderSaveBar()
}

async function load (): Promise<void> {
  fill(body, el('p', { className: 'status busy', textContent: 'Loading settings…' }))
  try {
    saved = await api<SettingsResponse>('/api/settings', { cache: 'no-store' })
  } catch (err) {
    const retry = el('button', { type: 'button', className: 'button', textContent: 'Try again' })
    retry.addEventListener('click', () => { load().catch(console.error) })
    fill(body, el('p', { className: 'status error', textContent: `Couldn’t load settings: ${err instanceof ApiError || err instanceof Error ? err.message : String(err)}` }), retry)
    return
  }
  render()
  watchLiveSections()
  scrollToHash()
  loadDebug().catch(console.error)
}

$('#savebar-save').addEventListener('click', () => { save().catch(console.error) })
$('#savebar-discard').addEventListener('click', () => {
  draft = {}
  setStatus($('#savebar-status'), '')
  render()
})
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return
  renderSaveBar()
  refresh().catch(console.error)
})
window.addEventListener('focus', () => { refresh().catch(console.error) })
window.addEventListener('pageshow', () => { renderSaveBar() })
window.addEventListener('beforeunload', e => { if (Object.keys(draft).length) e.preventDefault() })
onStatus(next => {
  status = next
  tested.clear()
  if (!saved) return
  renderSectionStatus()
  // Source status follows the latest checks; re-render the list only when nothing is being edited there
  const section = document.getElementById('sources')
  if (section && !('sources' in draft) && !section.contains(document.activeElement)) {
    section.replaceWith(renderSection('sources'))
    renderSectionStatus()
  }
})

// The Server and Debug sections show live numbers, refreshed while either is on screen
const onScreen = new Set<string>()
let observer: IntersectionObserver | null = null
function watchLiveSections (): void {
  observer?.disconnect()
  onScreen.clear()
  observer = new IntersectionObserver(entries => {
    for (const e of entries) {
      if (e.isIntersecting) onScreen.add(e.target.id)
      else onScreen.delete(e.target.id)
    }
  })
  for (const id of ['storage', 'debug']) {
    const node = document.getElementById(id)
    if (node) observer.observe(node)
  }
}
poll(loadDebug, { everyMs: 5000, when: () => onScreen.size > 0 })

load().catch(console.error)
