import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SETTINGS } from '@magplay/api-contract'
import { presentSetting } from './setting-rules.ts'

test('source presentation follows schema rules without changing values or definitions', () => {
  const sources = SETTINGS.find(d => d.key === 'sources')!
  assert.equal(sources.type, 'list')
  if (sources.type !== 'list') return
  const filter = sources.item.find(f => f.key === 'indexer')!
  const item = { type: 'jackett', indexer: '7' }
  assert.equal(presentSetting(filter, key => item[key as keyof typeof item]).hidden, false)
  item.type = 'torznab'
  assert.equal(presentSetting(filter, key => item[key as keyof typeof item]).hidden, true)
  assert.equal(item.indexer, '7')
  assert.equal(filter.hidden, true)
  item.type = 'prowlarr'
  assert.match(presentSetting(filter, key => item[key as keyof typeof item]).help!, /separated by commas/)
})

test('page setting dependencies use the same resolver and require the matching value type', () => {
  const def = SETTINGS.find(d => d.key === 'transcode.maxHeight')!
  assert.equal(presentSetting(def, () => false).disabled, true)
  assert.equal(presentSetting(def, () => true).disabled, undefined)
  assert.equal(presentSetting(def, () => 'false').disabled, undefined)
  assert.match(presentSetting(def, () => false).help!, /Turn on video conversion/)
  assert.equal(presentSetting(def, () => true).help, def.help)
})

test('schema rule dependencies name existing settings or sibling fields', () => {
  const settingKeys = new Set(SETTINGS.map(d => d.key))
  for (const def of SETTINGS) {
    for (const rule of def.rules ?? []) assert.ok(settingKeys.has(rule.when.key))
    if (def.type !== 'list') continue
    const fieldKeys = new Set(def.item.map(f => f.key))
    for (const field of def.item) for (const rule of field.rules ?? []) assert.ok(fieldKeys.has(rule.when.key))
  }
})
