import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fragmentSplitter, fragmentStart, readInit } from './mp4.ts'
import { fragment, initSegment } from './test-helpers.ts'

test('readInit finds the video track and every timescale; fragmentStart reads the video tfdt in seconds', () => {
  const init = readInit(initSegment())
  assert.equal(init.videoTrack, 1)
  assert.deepEqual([...init.timescales], [[1, 1000], [2, 48_000]])
  assert.equal(fragmentStart(fragment(30.25), init), 30.25)
  assert.equal(fragmentStart(fragment(1), { videoTrack: null, timescales: new Map() }), null)
})

test('fragmentSplitter hands over the init, then each moof and its mdat bytes, across arbitrary chunk boundaries', () => {
  const stream = Buffer.concat([initSegment(), fragment(10, 1000), fragment(12, 5)])
  for (const chunkSize of [1, 7, 64, stream.length]) {
    const events: string[] = []
    let bytes = 0
    const split = fragmentSplitter({
      init: data => events.push(`init ${data.length}`),
      begin: moof => { if (bytes) events.push(`data ${bytes}`); bytes = 0; events.push(`moof ${fragmentStart(moof, readInit(initSegment()))}`) },
      data: chunk => { bytes += chunk.length },
    })
    for (let at = 0; at < stream.length; at += chunkSize) split.push(stream.subarray(at, at + chunkSize))
    events.push(`data ${bytes}`)
    assert.deepEqual(events, [`init ${initSegment().length}`, 'moof 10', 'data 1008', 'moof 12', 'data 13'], `chunks of ${chunkSize}`)
    assert.equal(split.end(), true)
  }
})

test('fragmentSplitter reports a stream cut off inside a box', () => {
  const split = fragmentSplitter({ init: () => {}, begin: () => {}, data: () => {} })
  const stream = Buffer.concat([initSegment(), fragment(0, 100)])
  split.push(stream.subarray(0, stream.length - 10))
  assert.equal(split.end(), false)
})
