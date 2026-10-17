import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseVtt } from './subtitles.js'

test('subtitle parsing imports without browser globals and accepts empty/header-only snapshots', () => {
  assert.equal(typeof window, 'undefined')
  assert.equal(typeof document, 'undefined')
  for (const input of ['', 'WEBVTT', 'WEBVTT\n\n', '\uFEFFWEBVTT\r\n\r\n']) assert.deepEqual(parseVtt(input), [])
})

test('WebVTT timing supports hours, minutes and millisecond precision', () => {
  assert.deepEqual(parseVtt('WEBVTT\n\n00:00:01.125 --> 00:00:08.250\nFirst\n\n01:02.003 --> 01:03.004\nSecond\n\n100:02:03.004 --> 100:02:04.005\nLong file'), [
    { from: 1.125, to: 8.25, text: 'First' },
    { from: 62.003, to: 63.004, text: 'Second' },
    { from: 360123.004, to: 360124.005, text: 'Long file' },
  ])
})

test('cue identifiers/settings do not become payload; multiline markup is retained', () => {
  const input = 'WEBVTT\n\ncue-1\n00:01.000 --> 00:05.000 align:start position:10%\n<v Speaker><i>Hello</i></v>\nSecond line  \n\n'
  assert.deepEqual(parseVtt(input), [{ from: 1, to: 5, text: '<v Speaker><i>Hello</i></v>\nSecond line' }])
})

test('BOM, CRLF and CR-only files normalize without changing cue text', () => {
  const input = 'WEBVTT\n\n00:01.000 --> 00:05.000\nFirst\nSecond\n\n'
  const expected = [{ from: 1, to: 5, text: 'First\nSecond' }]
  assert.deepEqual(parseVtt('\uFEFF' + input.replace(/\n/g, '\r\n')), expected)
  assert.deepEqual(parseVtt(input.replace(/\n/g, '\r')), expected)
})

test('WebVTT header/NOTE/STYLE/REGION blocks are never parsed as cues', () => {
  const input = 'WEBVTT generated\nHeader metadata\n\nNOTE a comment\n00:01.000 --> 00:05.000\nNot a cue\n\nSTYLE\n::cue { color: lime; }\n00:01.000 --> 00:05.000\n\nREGION\nid:region-1\n00:01.000 --> 00:05.000\n\n00:06.000 --> 00:08.000\nReal cue'
  assert.deepEqual(parseVtt(input), [{ from: 6, to: 8, text: 'Real cue' }])
})

test('invalid timing is skipped rather than producing NaN, reversed or zero-length cues', () => {
  for (const timing of [
    'not-a-time --> 00:02.000',
    '00:01.000 --> NaN',
    '00:01.000 --> Infinity',
    '-00:01.000 --> 00:02.000',
    '00:60.000 --> 01:02.000',
    '00:60:00.000 --> 01:02:00.000',
    '00:02.000 --> 00:01.000',
    '00:01.000 --> 00:01.000',
    '00:01.000 --> 00:02.000 --> 00:03.000',
    '00:01 --> 00:02',
    '00:01.0 --> 00:02.0',
    '00:01.000 -->',
    `${'9'.repeat(400)}:01:00.000 --> ${'9'.repeat(400)}:02:00.000`,
  ]) {
    const input = `WEBVTT\n\n${timing}\nBad cue\n\n00:10.000 --> 00:12.000\nStill valid`
    assert.deepEqual(parseVtt(input), [{ from: 10, to: 12, text: 'Still valid' }], timing)
  }
})

test('partial snapshots retain earlier cues and recover the final cue when timing completes', () => {
  const first = 'WEBVTT\n\n00:01.000 --> 00:05.000\nFirst\n\n'
  const partial = first + '00:06.000 --> 00:08.'
  assert.deepEqual(parseVtt(partial), [{ from: 1, to: 5, text: 'First' }])
  assert.deepEqual(parseVtt(partial + '000\nLast cue'), [
    { from: 1, to: 5, text: 'First' }, { from: 6, to: 8, text: 'Last cue' },
  ])
})

test('complete timing with partial text is left to the player to withhold while growing', () => {
  const timing = 'WEBVTT\n\n00:01.000 --> 00:05.000\n'
  assert.deepEqual(parseVtt(timing), [{ from: 1, to: 5, text: '' }])
  assert.deepEqual(parseVtt(timing + 'Part'), [{ from: 1, to: 5, text: 'Part' }])
  assert.deepEqual(parseVtt(timing + 'Part completed\n\n'), [{ from: 1, to: 5, text: 'Part completed' }])
})

test('cue order, overlap and source timestamps remain unchanged for offset handling', () => {
  const input = 'WEBVTT\n\n00:01:10.000 --> 00:01:20.000\nLast\n\n00:01:00.000 --> 00:01:15.000\nOverlap'
  assert.deepEqual(parseVtt(input), [{ from: 70, to: 80, text: 'Last' }, { from: 60, to: 75, text: 'Overlap' }])
  assert.deepEqual(parseVtt(input), parseVtt(input)) // no accumulated parser state between polls
})
