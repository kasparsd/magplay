import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { runNodeRemux } from './node-remux.ts'

const fixture = path.join(import.meta.dirname, '../test-fixtures/h264-ac3-aac-srt.mkv')

test('a Node remux of an AC-3 MKV publishes fMP4 HLS with a real segment duration', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'magplay-node-remux-'))
  try {
    await runNodeRemux({
      input: fixture,
      dir,
      audio: 0,
      start: 0,
      signal: new AbortController().signal,
      position: () => 0,
      onOutput () {},
    })
    const playlist = await fs.readFile(path.join(dir, 'index.m3u8'), 'utf8')
    assert.match(playlist, /#EXT-X-MAP:URI="init\.mp4"/)
    assert.match(playlist, /#EXT-X-ENDLIST/)
    const duration = Number(playlist.match(/#EXTINF:([\d.]+)/)?.[1])
    assert.ok(duration > 0.4 && duration < 0.7, playlist)
    const init = await fs.readFile(path.join(dir, 'init.mp4'))
    assert.equal(init.subarray(4, 8).toString('ascii'), 'ftyp')
    const segment = await fs.readFile(path.join(dir, 'seg_00000.m4s'))
    assert.equal(segment.subarray(4, 8).toString('ascii'), 'moof')
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})
