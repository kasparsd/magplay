import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parts } from './view.ts'

test('a part is redrawn only when one of its values changes', () => {
  const { when, forget } = parts()
  const menu = { open: true }
  let draws = 0
  const draw = (): void => { draws++ }
  when('speed', [1, menu], draw)
  when('speed', [1, menu], draw)
  assert.equal(draws, 1)
  when('speed', [1.5, menu], draw)
  assert.equal(draws, 2)
  when('speed', [1.5, { open: true }], draw) // a new object is a change
  assert.equal(draws, 3)
  forget('speed')
  when('speed', [1.5, menu], draw)
  assert.equal(draws, 4)
})
