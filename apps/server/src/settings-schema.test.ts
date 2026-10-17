import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SETTINGS, defaults, isValueDef, overallLevel, settingDef, validate } from '@magplay/api-contract'
import type { StatusCheck, ValueDef } from '@magplay/api-contract'

const def = (key: string): ValueDef => {
  const d = settingDef(key)
  assert.ok(d && isValueDef(d), key)
  return d
}

test('keys are unique and every stored default validates against its own definition', () => {
  assert.equal(new Set(SETTINGS.map(d => d.key)).size, SETTINGS.length)
  for (const d of SETTINGS.filter(isValueDef)) assert.ok(validate(d, d.default).ok, d.key)
  assert.ok(SETTINGS.filter(d => d.scope === 'browser').every(d => !d.env && !d.apply))
})

test('validate normalizes and explains', () => {
  assert.deepEqual(validate(def('cache.maxGb'), ' 80 '), { ok: true, value: 80 })
  assert.deepEqual(validate(def('limits.probes'), 1.5), { ok: false, error: 'must be a whole number' })
  assert.deepEqual(validate(def('transcode.maxHeight'), '1080'), { ok: true, value: 1080 })
  assert.equal(validate(def('transcode.maxHeight'), 900).ok, false)
  assert.deepEqual(validate(def('explore.bitmagnetUrl'), ''), { ok: true, value: '' })
  assert.deepEqual(validate(def('explore.bitmagnetUrl'), 'bitmagnet:3333'), { ok: false, error: 'must be an http:// or https:// address' })
  assert.deepEqual(validate(def('player.autoplayNext'), 'off'), { ok: true, value: false })
})

test('list items get ids and field defaults, and name the item that is wrong', () => {
  const ok = validate(def('sources'), [{ type: 'prowlarr', url: 'http://prowlarr:9696' }])
  assert.ok(ok.ok)
  const [item] = ok.value as Array<Record<string, unknown>>
  assert.equal(typeof item?.id, 'string')
  assert.equal(item?.apiKey, '')
  assert.deepEqual(validate(def('sources'), [{ type: 'torznab', url: 'ftp://x' }]), { ok: false, error: 'source 1: address must be an http:// or https:// address' })
})

test('defaults are split by scope', () => {
  assert.equal(defaults('browser')['player.speed'], 1)
  assert.equal(defaults('server')['player.speed'], undefined)
})

test('the overall level is the worst result, and unknown only while a required check is', () => {
  const c = (level: StatusCheck['level'], required = true): StatusCheck => ({ id: level, label: level, level, required })
  assert.equal(overallLevel([c('ok'), c('warn'), c('error')]), 'error')
  assert.equal(overallLevel([c('ok'), c('unknown', false)]), 'ok')
  assert.equal(overallLevel([c('ok'), c('unknown')]), 'unknown')
  assert.equal(overallLevel([c('unknown'), c('warn', false)]), 'warn')
  assert.equal(overallLevel([]), 'unknown')
})
