import { test } from 'node:test'
import assert from 'node:assert/strict'
import { savedSpeed, speedLabel, steppedSpeed } from './player-speed.ts'

test('< and > step through the offered speeds and stop at the ends', () => {
  assert.equal(steppedSpeed(1, 1), 1.25)
  assert.equal(steppedSpeed(1, -1), 0.75)
  assert.equal(steppedSpeed(2, 1), 2)
  assert.equal(steppedSpeed(0.5, -1), 0.5)
  assert.equal(steppedSpeed(1.1, 1), 1.25) // an unlisted rate steps from normal speed
})

test('a remembered speed is used only if it is still offered', () => {
  assert.equal(savedSpeed(1.5), 1.5)
  assert.equal(savedSpeed(3), 1)
  assert.equal(savedSpeed('1.5'), 1)
  assert.equal(savedSpeed(null), 1)
  assert.equal(speedLabel(0.75), '0.75×')
})
