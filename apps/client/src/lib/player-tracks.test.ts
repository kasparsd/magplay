import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ProbeResult } from '@magplay/api-contract'
import { audioTrackLabel, audioTrackName, preferredSubtitle, subtitleOptions } from './player-tracks.ts'

const info: ProbeResult = {
  duration: 90,
  startTime: 0,
  container: 'matroska,webm',
  isWebm: false,
  audio: [],
  subtitles: [
    { index: 0, codec: 'subrip', language: 'eng', title: null, text: true },
    { index: 1, codec: 'hdmv_pgs_subtitle', language: 'lav', title: 'Signs', text: false },
    { index: 2, codec: 'ass', language: null, title: null, text: true },
  ],
  externalSubtitles: [{ idx: 4, name: 'Show/Show.S01E02.lv.srt' }],
}

test('subtitle options name embedded and external tracks and disable image subtitles', () => {
  assert.deepEqual(subtitleOptions(info), [
    { value: 'embedded:0', name: 'English', label: 'English', language: 'eng', disabled: false },
    { value: 'embedded:1', name: 'Latvian · Signs', label: 'Latvian · Signs (image, not supported)', language: 'lav', disabled: true },
    { value: 'embedded:2', name: 'Track 3', label: 'Track 3', language: null, disabled: false },
    { value: 'file:4', name: 'Latvian', label: 'Show.S01E02.lv.srt', language: 'lv', disabled: false },
  ])
})

test('the remembered preference picks a usable track by language, any track, or none', () => {
  const options = subtitleOptions(info)
  assert.equal(preferredSubtitle(options, 'eng'), 'embedded:0')
  assert.equal(preferredSubtitle(options, 'lav'), '') // the only Latvian embedded track is an image
  assert.equal(preferredSubtitle(options, 'lv'), 'file:4')
  assert.equal(preferredSubtitle(options, 'any'), 'embedded:0')
  assert.equal(preferredSubtitle(options, 'off'), '')
  assert.equal(preferredSubtitle(options, 'fre'), '')
  assert.equal(preferredSubtitle(options, null), '')
  assert.equal(preferredSubtitle([], 'any'), '')
})

test('audio tracks read as language and title, with the format in the menu', () => {
  const track = { index: 1, codec: 'ac3', channels: 6, language: 'eng', title: 'Commentary', default: false }
  assert.equal(audioTrackName(track), 'English · Commentary')
  assert.equal(audioTrackName({ ...track, language: null, title: null }), 'Track 2')
  assert.equal(audioTrackLabel(track), 'English · Commentary (AC3 5.1)')
})
