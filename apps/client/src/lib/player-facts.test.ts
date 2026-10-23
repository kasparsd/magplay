import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { PlaybackDecision, ProbeResult, TorrentStatus } from '@magplay/api-contract'
import { factRows } from './player-facts.ts'

const info: ProbeResult = {
  duration: 90,
  startTime: 0,
  container: 'mov,mp4,m4a,3gp,3g2,mj2',
  isWebm: false,
  video: { codec: 'h264', tag: 'avc1', profile: 'High', width: 1920, height: 800, sampleAspect: 1, bitDepth: 8 },
  audio: [{ index: 0, codec: 'aac', channels: 2, language: 'eng', title: null, default: true }],
  subtitles: [],
  externalSubtitles: [],
}

test('before anything is known, Details is empty', () => {
  assert.deepEqual(factRows({ decision: null, file: null, info: null, audio: 0, status: null, buffered: 0 }), [])
})

test('Details names the mode, file, container, tracks, torrent and ffmpeg', () => {
  const status = {
    preparation: null,
    loaded: true,
    activeStreams: 1,
    downloadSpeed: 2_500_000,
    uploadSpeed: 0,
    downloaded: 0,
    length: 0,
    progress: 0.5,
    files: [],
    peers: [{ address: null, client: null, downloadSpeed: 0, uploadSpeed: 0, downloaded: 0, uploaded: 0, share: 1, choking: false }],
    file: { idx: 0, progress: 0.42, ranges: [] },
    session: { id: 's', mode: 'remux', speed: 3.14, fps: null, cpu: null, produced: 0, readyUntil: 0, ready: [], growing: false, paused: true, running: true, failed: false, error: null },
  } satisfies TorrentStatus
  const decision: PlaybackDecision = { mode: 'remux', reason: 'AC-3 audio', duration: 90, url: '/hls/s/index.m3u8', session: 's', growing: false, subtitles: [] }
  assert.deepEqual(factRows({ decision, file: { name: 'Show/Show.S01E01.mp4', size: 1.5e9 }, info, audio: 0, status, buffered: 12.4 }), [
    ['Mode', 'remux: AC-3 audio'],
    ['File', 'Show.S01E01.mp4 (1.5 GB)'],
    ['Container', 'MP4'],
    ['Video', 'h264 High, 1920×800, 2.40:1, 8-bit'],
    ['Audio', 'AAC stereo, English'],
    ['Peers', '1 · ↓ 2.5 MB/s'],
    ['On the server', '42% of this file'],
    ['Buffered', '12 s ahead'],
    ['ffmpeg', '3.1x, paused far enough ahead'],
  ])
})
