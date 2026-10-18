import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMetrics, observeJob } from './metrics.ts'
import { createLogging } from './logger.ts'

test('metrics count work independently of log filtering and registries are isolated', async () => {
  const a = createMetrics({ runtime: false })
  const b = createMetrics({ runtime: false })
  const logging = createLogging({ level: 'silent', sink: { write () {} } })
  await observeJob(logging.logger, a.metrics, 'probe', () => Promise.resolve(1))
  await assert.rejects(observeJob(logging.logger, a.metrics, 'probe', () => Promise.reject(Object.assign(new Error('busy'), { name: 'PlaybackBusyError' }))))
  const text = await a.registry.metrics()
  assert.match(text, /magplay_jobs_total\{kind="probe",outcome="success"\} 1/)
  assert.match(text, /magplay_jobs_total\{kind="probe",outcome="rejected"\} 1/)
  assert.doesNotMatch(await b.registry.metrics(), /kind="probe"/)
  assert.equal(logging.tail().length, 0)
  a.close(); b.close()
})

test('request IDs and arbitrary inputs cannot grow metric cardinality', async () => {
  const a = createMetrics({ runtime: false })
  for (let i = 0; i < 1000; i++) {
    a.metrics.http(`/raw/${i}/film`, `METHOD-${i}`, 9999, 1)
    a.metrics.playback(`mode-${i}`, 'success', 1)
    a.metrics.reject('hls', `secret-${i}`)
  }
  const text = await a.registry.metrics()
  assert.doesNotMatch(text, /secret-|film|mode-\d/)
  assert.ok(text.split('\n').filter(line => line && !line.startsWith('#')).length < 1000)
  assert.match(text, /magplay_http_requests_total\{group="raw",method="other",status_class="other"\} 1000/)
  a.close()
})

test('server HLS readiness is only observed when published media is ready', async () => {
  const a = createMetrics({ runtime: false })
  a.metrics.playback('remux', 'success', 0.1)
  assert.doesNotMatch(await a.registry.metrics(), /magplay_playback_ready_seconds_count\{/)
  a.metrics.ready('remux', 1.5)
  assert.match(await a.registry.metrics(), /magplay_playback_ready_seconds_count\{mode="remux"\} 1/)
  a.drops(3); a.drops(3); a.drops(5)
  assert.match(await a.registry.metrics(), /magplay_telemetry_dropped_total 5/)
  a.close()
})

test('the complete bounded application label space fits the series budget', async () => {
  const a = createMetrics({ runtime: false })
  const outcomes = ['success', 'failure', 'timeout', 'rejected', 'cancelled'] as const
  for (const route of ['/health', '/', '/api/play', '/api/status', '/raw/:ih/:idx', '/tar/:ih', '/hls/:id/:file', '/subs/:ih/:idx', 'unmatched']) {
    for (const method of ['GET', 'HEAD', 'POST', 'PATCH', 'DELETE', 'other']) {
      for (const status of [101, 200, 300, 400, 500, 999]) a.metrics.http(route, method, status, 1)
    }
  }
  for (const mode of ['direct', 'remux', 'transcode', 'unknown', 'other']) {
    for (const result of outcomes) a.metrics.playback(mode, result, 1)
    a.metrics.ready(mode, 1)
  }
  for (const kind of ['source', 'explore', 'torrent', 'verification', 'probe', 'subtitle', 'conversion'] as const) {
    for (const result of outcomes) a.metrics.job(kind, result, 1)
  }
  for (const resource of ['hls', 'torrent', 'probe', 'subtitle', 'disk'] as const) {
    a.slots(resource, 0, 1)
    for (const reason of ['capacity', 'free-space', 'storage', 'other']) a.metrics.reject(resource, reason)
  }
  for (const kind of ['free', 'torrent', 'hls'] as const) a.storage(kind, 1)
  for (const kind of ['probe', 'subtitle', 'links', 'explore'] as const) a.cache(kind, 1)
  const count = (await a.registry.metrics()).split('\n').filter(line => line && !line.startsWith('#')).length
  assert.ok(count < 1000, `enumerated application series: ${count}`)
  a.close()
})
