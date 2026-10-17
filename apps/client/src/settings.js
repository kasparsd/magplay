import { browserSettings, settingsSchema, validateSetting } from '@magplay/api-contract'
import { ApiError, api } from './lib/api.ts'
import { control } from './lib/controls.ts'
import { measureConnection } from './lib/speedtest.ts'
import { $, copy, el, fill, formatBytes, formatSpeed, recall, remember, setStatus } from './lib/ui.ts'

const sections = [
  ['sources', 'Sources', 'On the server, applies to everyone.'],
  ['playback', 'Playback', 'Server settings apply to everyone; preferences stay in this browser.'],
  ['connection', 'Connection', 'Measured only in this browser when you run the test.'],
  ['server', 'Server', 'On the server, applies to everyone.'],
  ['debug', 'Debug', 'Diagnostics are safe to copy; secrets are never included.'],
]
let values = {}
let meta = {}
let initial = {}
const dirty = new Set()
const errors = new Map()
const browserValues = loadBrowserSettings()
let debugSnapshot
let debugRequest

function loadBrowserSettings () {
  const saved = recall('settings')
  const result = Object.fromEntries(browserSettings.map(def => [def.key, def.default]))
  if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
    for (const def of browserSettings) if (saved[def.key] !== undefined && !validateSetting(def, saved[def.key])) result[def.key] = saved[def.key]
  }
  return result
}
function setBrowser (key, value) {
  browserValues[key] = value
  remember('settings', browserValues)
}
function setServer (key, value) {
  const wasDirty = dirty.has(key)
  values[key] = key === 'sources' ? [...values.sources.slice(0, meta.sources?.envSources ?? 0), ...value] : value
  if (JSON.stringify(values[key]) === JSON.stringify(initial[key])) dirty.delete(key)
  else dirty.add(key)
  const clearedError = errors.delete(key)
  if (key === 'sources') render()
  else if (wasDirty !== dirty.has(key) || clearedError) renderSaveBar()
}
function sourceEditor (source, index, locked) {
  const fields = [
    ['name', 'Name', 'text'], ['url', 'Address', 'url'], ['apiKey', source.apiKeySet ? 'API key (saved)' : 'API key', 'password'],
  ]
  const inputs = fields.map(([key, label, type]) => {
    const input = el('input', { type, value: key === 'apiKey' ? '' : String(source[key] ?? ''), placeholder: key === 'apiKey' && source.apiKeySet ? 'Saved — enter to replace' : '', disabled: locked, ariaLabel: label })
    input.addEventListener('change', () => {
      const editable = values.sources.slice((meta.sources?.envSources ?? 0))
      const item = editable[index - (meta.sources?.envSources ?? 0)]
      if (!item) return
      item[key] = input.value
      if (key === 'apiKey' && input.value) item.apiKeySet = true
      setServer('sources', editable)
    })
    return el('label', {}, el('span', { className: 'field-label', textContent: label }), input)
  })
  const type = el('select', { disabled: locked })
  for (const name of ['torznab', 'jackett', 'prowlarr']) type.append(el('option', { value: name, textContent: name === 'torznab' ? 'Torznab' : name[0].toUpperCase() + name.slice(1), selected: source.type === name }))
  type.addEventListener('change', () => {
    const editable = values.sources.slice((meta.sources?.envSources ?? 0))
    editable[index - (meta.sources?.envSources ?? 0)].type = type.value
    setServer('sources', editable)
  })
  const testStatus = el('span', { className: 'source-test-status', ariaLive: 'polite' })
  const test = el('button', { type: 'button', className: 'button', textContent: 'Test' })
  test.addEventListener('click', async () => {
    test.disabled = true
    test.textContent = 'Testing…'
    testStatus.className = 'source-test-status busy'
    testStatus.textContent = 'Testing source…'
    try {
      const result = await api('/api/settings/test', { json: { source: values.sources[index] } })
      testStatus.className = `source-test-status ${result.level === 'ok' ? 'good' : 'error'}`
      testStatus.textContent = result.message ?? result.value ?? 'Source is connected.'
    } catch (err) {
      testStatus.className = 'source-test-status error'
      testStatus.textContent = err.message
    } finally {
      test.disabled = false
      test.textContent = 'Test'
    }
  })
  const actions = el('p', { className: 'source-actions' },
    test,
    testStatus,
    !locked && el('button', {
      type: 'button',
      className: 'quiet-button',
      textContent: 'Remove',
      onclick: () => {
        const editable = values.sources.slice((meta.sources?.envSources ?? 0))
        editable.splice(index - (meta.sources?.envSources ?? 0), 1)
        setServer('sources', editable)
      }
    }),
    locked && el('span', { className: 'help', textContent: `Set by ${meta.sources?.env ?? 'the environment'}; change it outside magplay to edit.` }))
  return el('div', { className: 'source-editor' },
    el('fieldset', { className: 'source-editor-fields', disabled: locked }, el('legend', { textContent: source.name || 'New source' }), el('label', {}, el('span', { className: 'field-label', textContent: 'Type' }), type), ...inputs),
    actions)
}

function sourceSettings () {
  const locked = meta.sources?.envSources ?? 0
  const list = values.sources ?? []
  return el('div', { className: 'sources-list' },
    ...list.map((source, index) => sourceEditor(source, index, index < locked)),
    el('button', {
      type: 'button',
      className: 'button',
      textContent: 'Add source',
      onclick: () => {
        const editable = values.sources.slice(locked)
        editable.push({ id: crypto.randomUUID(), type: 'torznab', name: '', url: '', apiKey: '' })
        setServer('sources', editable)
      }
    }))
}

function connectionSection () {
  const stored = recall('connection')
  const result = stored && typeof stored === 'object' && Date.now() - stored.at < 7 * 86400_000 ? stored : null
  const output = result ? `Last result: ${formatSpeed(result.downBytesPerSec)} · ${Math.round(result.latencyMs)} ms latency` : 'No connection test has been run in this browser.'
  const run = el('button', { type: 'button', className: 'button primary', textContent: 'Run speed test' })
  run.addEventListener('click', async () => {
    run.disabled = true
    run.textContent = 'Testing…'
    try { remember('connection', await measureConnection()); render() } catch (err) { alert(err.message) } finally { run.disabled = false; run.textContent = 'Run speed test' }
  })
  return el('div', { className: 'connection-test' }, el('p', { textContent: output }), run)
}

async function debugSection () {
  const box = el('div', { className: 'debug-readout' }, el('p', { className: 'status busy', textContent: 'Loading diagnostics…' }))
  try {
    debugRequest ??= api('/api/debug').then(result => { debugSnapshot = result; return result }, err => { debugRequest = undefined; throw err })
    const debug = debugSnapshot ?? await debugRequest
    const memory = debug.memory?.rss ? formatBytes(debug.memory.rss) : 'Unknown'
    fill(box, el('dl', {}, el('dt', { textContent: 'Version' }), el('dd', { textContent: debug.version }), el('dt', { textContent: 'Runtime' }), el('dd', { textContent: `${debug.node} · ${debug.platform}` }), el('dt', { textContent: 'Uptime' }), el('dd', { textContent: `${Math.floor(debug.uptimeSeconds / 60)} minutes` }), el('dt', { textContent: 'Memory' }), el('dd', { textContent: memory })), el('button', { type: 'button', className: 'button', textContent: 'Copy diagnostics', onclick: () => copy(JSON.stringify(debug, null, 2)) }))
  } catch (err) { fill(box, el('p', { className: 'status error', textContent: err.message })) }
  return box
}

function render () {
  const root = $('#settings-sections')
  const sectionNodes = sections.map(([id, label, note]) => {
    const defs = settingsSchema.filter(def => def.section === id && def.type !== 'list')
    const serverDefs = defs.filter(def => def.scope === 'server')
    const browserDefs = defs.filter(def => def.scope === 'browser')
    const allLocked = serverDefs.length > 0 && serverDefs.every(def => meta[def.key]?.source === 'env')
    const fields = [
      id === 'sources' && sourceSettings(),
      ...serverDefs.map(def => control(def, { value: values[def.key], disabled: meta[def.key]?.source === 'env', error: errors.get(def.key), onChange: value => setServer(def.key, value) })),
      ...browserDefs.map(def => control(def, { value: browserValues[def.key], onChange: value => setBrowser(def.key, value) })),
      id === 'connection' && connectionSection(),
    ]
    const section = el('section', { className: 'settings-section' }, el('h2', { textContent: label }), el('p', { className: 'section-note', textContent: note }), allLocked && el('p', { className: 'locked-note', textContent: 'Every setting in this section is set by the environment.' }), ...fields)
    if (id === 'debug') debugSection().then(node => section.append(node)).catch(() => {})
    return section
  })
  fill(root, ...sectionNodes)
  renderSaveBar()
}

function renderSaveBar () {
  const bar = $('#save-bar')
  if (!dirty.size) { bar.hidden = true; return }
  fill(bar,
    el('span', { textContent: `${dirty.size} unsaved change${dirty.size === 1 ? '' : 's'}` }),
    el('button', { type: 'button', className: 'button', textContent: 'Discard', onclick: () => { values = structuredClone(initial); dirty.clear(); errors.clear(); render() } }),
    el('button', { type: 'button', className: 'button primary', textContent: 'Save', onclick: save }))
  bar.hidden = false
}

async function save () {
  const patch = Object.fromEntries([...dirty].map(key => [key, key === 'sources' ? values.sources.slice(meta.sources?.envSources ?? 0) : values[key]]))
  try {
    const result = await api('/api/settings', { method: 'PATCH', json: { patch } })
    values = result.values
    meta = result.meta
    initial = structuredClone(values)
    dirty.clear()
    errors.clear()
    render()
  } catch (err) {
    if (err instanceof ApiError && err.status === 422) {
      const fieldErrors = err.body?.errors
      if (Array.isArray(fieldErrors)) for (const field of fieldErrors) errors.set(field.key, field.message)
      else for (const key of dirty) errors.set(key, err.message)
      render()
    } else alert(err.message)
  }
}

async function load () {
  try {
    const settings = await api('/api/settings')
    values = settings.values
    meta = settings.meta
    initial = structuredClone(values)
    $('#settings-layout').hidden = false
    setStatus($('#settings-status'), '')
    render()
  } catch (err) {
    setStatus($('#settings-status'), `Could not load settings: ${err.message}`, 'error')
    const retry = el('button', { type: 'button', className: 'button', textContent: 'Try again', onclick: load })
    $('#settings-status').after(retry)
  }
}

load().catch(() => {})
