import assert from 'node:assert/strict'
import { test } from 'node:test'
import { settingByKey, validateSetting } from './settings.ts'

test('settings schema validates numeric, URL and source-list input at the shared boundary', () => {
  const timeout = settingByKey.get('searchTimeoutS')
  const source = settingByKey.get('sources')
  const bitmagnet = settingByKey.get('bitmagnetUrl')
  const floor = settingByKey.get('minFreeGb')
  assert.ok(timeout && source && bitmagnet && floor)
  assert.equal(validateSetting(timeout, 0), 'Enter 1 or more.')
  assert.equal(validateSetting(timeout, 20), null)
  assert.equal(validateSetting(floor, 0.25), null)
  assert.equal(validateSetting(floor, 0), 'Enter 0.01 or more.')
  assert.equal(validateSetting(bitmagnet, 'file:///cache'), 'Enter an http(s) address.')
  assert.equal(validateSetting(source, [{ type: 'torznab', name: 'Local', url: 'http://indexer.test', apiKey: 'key' }]), null)
  assert.equal(validateSetting(source, [{ type: 'other', name: 'Local', url: 'http://indexer.test' }]), 'Choose a supported source type.')
})
