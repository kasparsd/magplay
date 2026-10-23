import { test } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { MediaTools } from '@magplay/playback'
import type { TorrentEngine } from '@magplay/torrent-engine'
import { createSubtitles } from './subtitles.ts'

function subtitles (vtt: (track: number | null) => Promise<string>, limits: { limit?: number, byteLimit?: number }, { name = 'Movie.mkv', ffmpeg = true, input = (): string => 'http://raw' } = {}) {
  let conversions = 0
  const engine = { file: () => Promise.resolve({ name }) } as unknown as TorrentEngine
  const media = { serverConversion: () => ffmpeg, subtitleToVtt: (_input: string, track: number | null) => { conversions++; return vtt(track) } } as unknown as MediaTools
  return { subs: createSubtitles({ engine, media, input, ...limits }), conversions: () => conversions }
}

test('converted tracks are cached, least recently used first out, by count', async () => {
  const { subs, conversions } = subtitles(track => Promise.resolve(`WEBVTT ${track}`), { limit: 2 })
  await subs.vtt('a', 0, '1.vtt')
  await subs.vtt('a', 0, '2.vtt')
  await subs.vtt('a', 0, '1.vtt') // a hit, and now the most recent
  await subs.vtt('a', 0, '3.vtt') // evicts track 2
  assert.equal(conversions(), 3)
  assert.equal(subs.stats().tracks, 2)
  await subs.vtt('a', 0, '1.vtt')
  assert.equal(conversions(), 3)
  await subs.vtt('a', 0, '2.vtt')
  assert.equal(conversions(), 4)
})

test('the cache stays under its byte limit, but always keeps the newest track', async () => {
  const { subs } = subtitles(() => Promise.resolve('x'.repeat(600)), { byteLimit: 1000 })
  await subs.vtt('a', 0, '1.vtt')
  await subs.vtt('a', 0, '2.vtt')
  assert.deepEqual([subs.stats().tracks, subs.stats().bytes], [1, 600])
  const big = subtitles(() => Promise.resolve('x'.repeat(5000)), { byteLimit: 1000 })
  await big.subs.vtt('a', 0, '1.vtt')
  assert.deepEqual([big.subs.stats().tracks, big.subs.stats().bytes], [1, 5000])
})

test('a failed conversion is forgotten so the next request retries', async () => {
  let fail = true
  const { subs, conversions } = subtitles(() => fail ? Promise.reject(new Error('no')) : Promise.resolve('WEBVTT'), {})
  await assert.rejects(subs.vtt('a', 0, '1.vtt'))
  assert.equal(subs.stats().tracks, 0)
  fail = false
  assert.equal(await subs.vtt('a', 0, '1.vtt'), 'WEBVTT')
  assert.equal(conversions(), 2)
})

test('SubRip and WebVTT files convert in Node; other formats and embedded tracks need ffmpeg', async t => {
  const server = createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('1\n00:00:01,000 --> 00:00:02,500\nHello\n\n2\n00:00:03,000 --> 00:00:04,000\n<i>World</i>\n') })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise(resolve => server.close(resolve)))
  const address = server.address() as AddressInfo
  const url = `http://127.0.0.1:${address.port}/raw/a/1`
  const srt = subtitles(() => Promise.reject(new Error('ffmpeg must not run')), {}, { name: 'Movie.srt', ffmpeg: false, input: () => url })
  assert.equal(await srt.subs.vtt('a', 1, 'file.vtt'), 'WEBVTT\n\n00:00:01.000 --> 00:00:02.500\nHello\n\n00:00:03.000 --> 00:00:04.000\n<i>World</i>\n')
  assert.equal(srt.conversions(), 0)
  const ass = subtitles(() => Promise.resolve('WEBVTT'), {}, { name: 'Movie.ass', ffmpeg: false })
  await assert.rejects(ass.subs.vtt('a', 1, 'file.vtt'), /no ffmpeg/)
  const embedded = subtitles(() => Promise.resolve('WEBVTT'), {}, { ffmpeg: false })
  await assert.rejects(embedded.subs.vtt('a', 0, '0.vtt'), /no ffmpeg/)
  const withFfmpeg = subtitles(() => Promise.resolve('WEBVTT'), {}, { name: 'Movie.ass' })
  assert.equal(await withFfmpeg.subs.vtt('a', 1, 'file.vtt'), 'WEBVTT')
})
