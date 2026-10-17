import { test } from 'node:test'
import assert from 'node:assert/strict'
import { audioCodecLabel, audioTrackLabel, channelsLabel, containerLabel } from './media-labels.ts'

const MP4_FAMILY = 'mov,mp4,m4a,3gp,3g2,mj2'

test('containers read as one name, with the extension choosing within ffprobe\'s family', () => {
  assert.equal(containerLabel(MP4_FAMILY, 'Big Buck Bunny.mp4'), 'MP4')
  assert.equal(containerLabel(MP4_FAMILY, 'clip.mov'), 'QuickTime')
  assert.equal(containerLabel(MP4_FAMILY), 'MP4')
  assert.equal(containerLabel('matroska,webm', 'Show.S01E02.mkv'), 'Matroska')
  assert.equal(containerLabel('matroska,webm', 'clip.webm'), 'WebM')
  assert.equal(containerLabel('mpegts', 'a.ts'), 'MPEG-TS')
  assert.equal(containerLabel('avi', 'wrongly-named.mkv'), 'AVI') // the extension can't override a different format
  assert.equal(containerLabel('nut'), 'NUT')
  assert.equal(containerLabel(null), '')
})

test('audio tracks read as codec and channel layout', () => {
  assert.equal(audioTrackLabel({ codec: 'mp3', channels: 2 }), 'MP3 stereo')
  assert.equal(audioTrackLabel({ codec: 'ac3', channels: 6, title: 'Commentary' }), 'Commentary (Dolby Digital 5.1)')
  assert.equal(audioTrackLabel({}), 'Audio')
  assert.equal(audioCodecLabel('wmav2'), 'WMAV2')
  assert.equal(channelsLabel(1), 'mono')
  assert.equal(channelsLabel(3), '3 ch')
})
