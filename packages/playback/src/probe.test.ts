import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { once } from 'node:events'
import { codecDetails, keyframeBefore, probe } from './probe.ts'
import { matroskaSubtitles } from './matroska-tracks.ts'
import { MediaToolError } from './errors.ts'

// Half-second files made with ffmpeg (64×64 testsrc2 + sine): the containers, codecs and tags the decision reads
const fixture = (name: string): string => path.join(import.meta.dirname, '../test-fixtures', name)

test('MP4: H.264 + AAC, profile and depth from the codec string, duration from the header', async () => {
  const info = await probe(fixture('h264-aac.mp4'), 'h264-aac.mp4')
  assert.equal(info.container, 'mp4')
  assert.equal(info.isWebm, false)
  assert.equal(info.duration, 0.5)
  assert.deepEqual(info.video, { codec: 'h264', tag: 'avc1', profile: 'Baseline', width: 64, height: 64, sampleAspect: 1, bitDepth: 8 })
  assert.deepEqual(info.audio, [{ index: 0, codec: 'aac', channels: 1, language: null, title: null, default: true }])
  assert.deepEqual(info.subtitles, [])
})

test('MKV: audio order, languages, titles, default flags and the embedded subtitle track', async () => {
  const info = await probe(fixture('h264-ac3-aac-srt.mkv'), 'Show.S01E02.mkv')
  assert.equal(info.container, 'matroska')
  assert.equal(info.video?.codec, 'h264')
  assert.equal(info.video?.tag, 'V_MPEG4/ISO/AVC')
  assert.deepEqual(info.audio, [
    { index: 0, codec: 'ac3', channels: 1, language: 'eng', title: 'Surround', default: true },
    { index: 1, codec: 'aac', channels: 1, language: 'lav', title: null, default: false },
  ])
  assert.deepEqual(info.subtitles, [{ index: 0, codec: 'subrip', language: 'eng', title: 'English', text: true }])
})

test('WebM: VP9 + Opus', async () => {
  const info = await probe(fixture('vp9-opus.webm'), 'clip.webm')
  assert.equal(info.container, 'webm')
  assert.equal(info.isWebm, true)
  assert.equal(info.video?.codec, 'vp9')
  assert.equal(info.video?.bitDepth, 8)
  assert.equal(info.audio[0]?.codec, 'opus')
})

test('HEVC: sample entry tag and 10-bit Main 10; 10-bit H.264 (Hi10P) in MKV', async () => {
  const main10 = await probe(fixture('hevc10-hvc1.mp4'), 'x.mp4')
  assert.equal(main10.video?.codec, 'hevc')
  assert.equal(main10.video?.tag, 'hvc1')
  assert.equal(main10.video?.profile, 'Main 10')
  assert.equal(main10.video?.bitDepth, 10)
  const hev1 = await probe(fixture('hevc-hev1.mp4'), 'x.mp4')
  assert.equal(hev1.video?.tag, 'hev1')
  assert.equal(hev1.video?.bitDepth, 8)
  assert.deepEqual(hev1.audio, [])
  const hi10 = await probe(fixture('h264-10bit.mkv'), 'x.mkv')
  assert.equal(hi10.video?.profile, 'High 10')
  assert.equal(hi10.video?.bitDepth, 10)
})

test('codec strings: depth fields of VP9 and AV1, unknown strings default to 8-bit', () => {
  assert.deepEqual(codecDetails('vp9', 'vp09.02.10.10.01.09.16.09.01'), { profile: 'Profile 2', bitDepth: 10 })
  assert.deepEqual(codecDetails('av1', 'av01.0.08M.10'), { profile: 'Main', bitDepth: 10 })
  assert.deepEqual(codecDetails('av1', 'av01.0.01M.08'), { profile: 'Main', bitDepth: 8 })
  assert.deepEqual(codecDetails('h264', 'avc1.640028'), { profile: 'High', bitDepth: 8 })
  assert.deepEqual(codecDetails('mpeg4', null), { profile: null, bitDepth: 8 })
})

test('unreadable inputs are media tool errors', async () => {
  await assert.rejects(probe(fixture('../src/probe.ts'), 'probe.ts'), MediaToolError)
  await assert.rejects(probe(fixture('missing.mkv'), 'missing.mkv'), MediaToolError)
})

test('an HTTP input is read with Range requests, head first, never whole', async t => {
  const data = await fs.readFile(fixture('h264-ac3-aac-srt.mkv'))
  const ranges: string[] = []
  const server = http.createServer((req, res) => {
    if (req.url !== '/raw/x/1') { res.writeHead(404); return res.end() }
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '')
    if (!range) { res.writeHead(200, { 'Content-Length': data.length, 'Accept-Ranges': 'bytes' }); return res.end(req.method === 'HEAD' ? undefined : data) }
    ranges.push(req.headers.range!)
    const start = Number(range[1])
    const end = Math.min(range[2] ? Number(range[2]) : data.length - 1, data.length - 1)
    res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${data.length}`, 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes' })
    res.end(data.subarray(start, end + 1))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise(resolve => server.close(resolve)))
  const address = server.address()
  const url = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/raw/x/1`
  const info = await probe(url, 'x.mkv')
  assert.equal(info.audio.length, 2)
  assert.equal(info.subtitles.length, 1)
  assert.ok(ranges.length > 0)
  assert.ok(ranges.every(r => r.startsWith('bytes=')))
  assert.equal(await keyframeBefore(url, 0.3), 0)
  assert.equal(await keyframeBefore(url, 0), 0)
  assert.equal(await keyframeBefore(`${url}-missing`, 5), 5) // unreadable: the request time itself
})

test('Matroska subtitle scan follows the SeekHead and tolerates junk', async () => {
  const data = await fs.readFile(fixture('h264-ac3-aac-srt.mkv'))
  const read = (start: number, end: number): Promise<Uint8Array> => Promise.resolve(new Uint8Array(data.subarray(start, end)))
  assert.deepEqual(await matroskaSubtitles(read), [{ index: 0, codec: 'subrip', language: 'eng', title: 'English', text: true }])
  assert.deepEqual(await matroskaSubtitles(() => Promise.resolve(new Uint8Array(16))), [])
  assert.deepEqual(await matroskaSubtitles(() => Promise.resolve(new Uint8Array(0))), [])
})
