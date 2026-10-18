import { test } from 'node:test'
import assert from 'node:assert/strict'
import { keyCommand } from './player-keys.ts'

test('the documented keys map to their commands in either case', () => {
  assert.equal(keyCommand(' '), 'playPause')
  assert.equal(keyCommand('K'), 'playPause')
  assert.equal(keyCommand('j'), 'back')
  assert.equal(keyCommand('ArrowRight'), 'forward')
  assert.equal(keyCommand('ArrowUp'), 'volumeUp')
  assert.equal(keyCommand('M'), 'mute')
  assert.equal(keyCommand('f'), 'fullscreen')
  assert.equal(keyCommand('c'), 'subtitles')
  assert.equal(keyCommand('N'), 'next')
  assert.equal(keyCommand('<'), 'slower')
  assert.equal(keyCommand('>'), 'faster')
  assert.equal(keyCommand('x'), undefined)
  assert.equal(keyCommand('toString'), undefined)
  assert.equal(keyCommand('arrowleft'), undefined) // named keys are case-sensitive
})
