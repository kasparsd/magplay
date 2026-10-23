import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fixedPlan, keyframePlan, renderPlaylist, runStart, segmentAt } from './plan.ts'

const keyframes = [0, 2.5, 3, 7.75, 13, 14.25, 20, 21, 27.5, 33, 40, 41, 48, 55, 59.5]

test('keyframePlan starts segments on keyframes at least 6 s apart and never leaves a last segment under 1 s', () => {
  const plan = keyframePlan(keyframes, 60, -0.005)
  assert.deepEqual(plan.starts, [0, 7.75, 14.25, 21, 27.5, 40, 48, 55])
  assert.equal(plan.origin, 0)
  assert.deepEqual(keyframePlan([0.042, 1, 2], 3, 0).starts, [0])
})

test('fixedPlan cuts every 6 s from where a run from the beginning starts', () => {
  assert.deepEqual(fixedPlan(20, 0).starts, [0, 6, 12, 18])
  assert.deepEqual(fixedPlan(19.5, 1.4).starts, [0, 7.4, 13.4])
  assert.equal(fixedPlan(19.5, 1.4).origin, 1.4)
})

test('segmentAt finds the segment holding a time, tolerating rounding at boundaries', () => {
  const { starts } = keyframePlan(keyframes, 60, 0)
  assert.equal(segmentAt(starts, 0), 0)
  assert.equal(segmentAt(starts, 7.72), 0)
  assert.equal(segmentAt(starts, 7.74), 1) // within the tolerance of the boundary
  assert.equal(segmentAt(starts, 30), 4)
  assert.equal(segmentAt(starts, 999), starts.length - 1)
  assert.equal(segmentAt(starts, -5), 0)
})

test('runStart warms copied video up from the keyframe before the boundary; transcode starts on it', () => {
  const plan = keyframePlan(keyframes, 60, -0.005)
  assert.equal(runStart(plan, 0), 0)
  assert.equal(runStart(plan, 3), 20 + 0.15) // boundary 21, previous keyframe 20
  assert.equal(runStart(plan, 1), 3 + 0.15)
  assert.equal(runStart(keyframePlan([0, 6.5], 20, 1.2), 1), 1.2) // the keyframe before is the start itself
  assert.equal(runStart(fixedPlan(30, 0), 2), 12)
})

test('renderPlaylist lists every segment for VOD and grows an EVENT playlist until it ends', () => {
  const vod = renderPlaylist({ starts: [0, 7.75, 14.25], end: 20.5, vod: true, ended: false })
  assert.match(vod, /#EXT-X-PLAYLIST-TYPE:VOD/)
  assert.match(vod, /#EXT-X-TARGETDURATION:8\n/)
  assert.match(vod, /#EXT-X-MAP:URI="init.mp4"/)
  assert.match(vod, /#EXTINF:7\.750000,\nseg_0\.m4s\n#EXTINF:6\.500000,\nseg_1\.m4s\n#EXTINF:6\.250000,\nseg_2\.m4s\n#EXT-X-ENDLIST/)
  const growing = renderPlaylist({ starts: [0, 6], end: 12, vod: false, ended: false })
  assert.match(growing, /#EXT-X-PLAYLIST-TYPE:EVENT/)
  assert.doesNotMatch(growing, /ENDLIST/)
  assert.match(renderPlaylist({ starts: [0, 6], end: 12, vod: false, ended: true }), /#EXT-X-ENDLIST/)
})
