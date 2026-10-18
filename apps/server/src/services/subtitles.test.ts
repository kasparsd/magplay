import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { MediaTools } from '@magplay/playback'
import type { TorrentEngine } from '@magplay/torrent-engine'
import { createSubtitles } from './subtitles.ts'

function subtitles (vtt: (track: number | null) => Promise<string>, limits: { limit?: number, byteLimit?: number }) {
  let conversions = 0
  const engine = { file: () => Promise.resolve() } as unknown as TorrentEngine
  const media = { subtitleToVtt: (_input: string, track: number | null) => { conversions++; return vtt(track) } } as unknown as MediaTools
  return { subs: createSubtitles({ engine, media, input: () => 'http://raw', ...limits }), conversions: () => conversions }
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
