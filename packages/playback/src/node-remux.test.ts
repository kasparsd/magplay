import { test } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import type { EventEmitter } from 'node:events'
import path from 'node:path'
import { TIMELINE_OFFSET } from './media.ts'
import { fragmentSplitter, fragmentStart, readInit } from './mp4.ts'
import type { InitInfo } from './mp4.ts'
import { nodeRemuxProcess } from './node-remux.ts'

const fixture = path.join(import.meta.dirname, '../test-fixtures/h264-ac3-aac-srt.mkv')
// 16 s, longer than one conversion step, with a 5.1 and a 5.0 AC-3 track
const multichannel = path.join(import.meta.dirname, '../test-fixtures/h264-ac3-5.1-5.0.mkv')

/** Runs a Node remux to the end; returns how it closed and each video fragment's start on the file timeline. */
async function run (firstKeyframe: number | null, input = fixture, audio = 0): Promise<{ code: unknown, init: InitInfo | null, starts: number[] }> {
  const proc = nodeRemuxProcess({ input, audio, start: 0, firstKeyframe })
  let init: InitInfo | null = null
  const starts: number[] = []
  const split = fragmentSplitter({
    init: data => { init = readInit(data) },
    begin: moof => {
      const at = init && fragmentStart(moof, init)
      if (at != null) starts.push(at - TIMELINE_OFFSET)
    },
    data: () => {},
  })
  ;(proc.stdio[3] as NodeJS.ReadableStream).on('data', (chunk: Buffer) => split.push(chunk))
  const [code] = await once(proc as unknown as EventEmitter, 'close') as [unknown]
  return { code, init, starts }
}

test('a Node remux of an AC-3 MKV streams fragmented MP4 like an ffmpeg run, on the file timeline', async () => {
  const { code, init, starts } = await run(0)
  assert.equal(code, 0)
  assert.ok(init, 'no init segment')
  assert.ok(starts.length > 0, 'no video fragment')
  assert.ok(Math.abs(starts[0]!) < 0.001, `first video fragment at ${starts[0]}`)
})

test('without a keyframe to anchor to, a Node remux keeps its own timeline from zero', async () => {
  const { code, starts } = await run(null)
  assert.equal(code, 0)
  assert.ok(starts[0]! >= 0 && starts[0]! < 0.1, `first video fragment at ${starts[0]}`)
})

for (const [audio, layout] of [[0, '5.1'], [1, '5.0']] as const) {
  test(`a Node remux downmixes ${layout} AC-3 and streams past its first step`, async () => {
    const { code, init, starts } = await run(0, multichannel, audio)
    assert.equal(code, 0)
    assert.equal(init?.timescales.size, 2, 'expected a video and an audio track')
    assert.ok(starts.at(-1)! > 12, `last video fragment at ${starts.at(-1)}`)
  })
}

test('SIGSTOP pauses a Node remux and SIGKILL cancels it with a signal, as with ffmpeg', async () => {
  const proc = nodeRemuxProcess({ input: fixture, audio: 0, start: 0, firstKeyframe: 0 })
  proc.kill('SIGSTOP')
  proc.kill('SIGKILL')
  const [code, signal] = await once(proc as unknown as EventEmitter, 'close') as [unknown, unknown]
  assert.equal(code, null)
  assert.equal(signal, 'SIGKILL')
})
