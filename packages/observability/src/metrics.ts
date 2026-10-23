import { randomUUID } from 'node:crypto'
import { Counter, Gauge, Histogram, Registry } from '@prometheus-io/client'
import { collectRuntime } from './runtime.ts'
import { noopLogger } from './logger.ts'
import type { Logger, Fields } from './logger.ts'

export type Outcome = 'success' | 'failure' | 'timeout' | 'rejected' | 'cancelled'
export type JobKind = 'source' | 'explore' | 'torrent' | 'verification' | 'probe' | 'subtitle' | 'conversion'
export type Resource = 'hls' | 'torrent' | 'probe' | 'subtitle' | 'disk'
export interface OperationContext { logger: Logger }
export interface Metrics {
  http: (route: string, method: string, status: number, seconds: number) => void
  playback: (mode: string, result: Outcome, seconds: number) => void
  ready: (mode: string, seconds: number) => void
  job: (kind: JobKind, result: Outcome, seconds: number) => void
  reject: (resource: Resource, reason: string) => void
}
export const noopMetrics: Metrics = { http () {}, playback () {}, ready () {}, job () {}, reject () {} }
export function outcome (err: unknown): Outcome {
  const e = err as { name?: string, status?: number }
  if (e?.status === 499 || e?.name === 'AbortError') return 'cancelled'
  if (/Timeout/.test(e?.name ?? '')) return 'timeout'
  if (/Busy|Unplayable/.test(e?.name ?? '') || e?.status === 409 || e?.status === 422) return 'rejected'
  return 'failure'
}
const oneOf = (value: string, values: readonly string[]): string => values.includes(value) ? value : 'other'
const GROUPS = ['health', 'static', 'control', 'status', 'raw', 'tar', 'hls', 'subs', 'other']
export function routeGroup (route: string): string {
  if (route === '/health') return 'health'
  if (/^\/(raw|tar|hls|subs)\//.test(route)) return route.split('/')[1]!
  if (/status|debug/.test(route)) return 'status'
  if (route.startsWith('/api/')) return 'control'
  return route === 'unmatched' || route === 'malformed' ? 'other' : 'static'
}
export function createMetrics ({ version = 'unknown', runtime = true }: { version?: string, runtime?: boolean } = {}) {
  const registry = new Registry()
  let stopRuntime: (() => void) | undefined = runtime ? collectRuntime(registry) : undefined
  const registers = [registry]
  new Gauge({ name: 'magplay_build_info', help: 'Application version', labelNames: ['version'], registers }).set({ version }, 1)
  const requests = new Counter({ name: 'magplay_http_requests_total', help: 'Terminal HTTP responses', labelNames: ['group', 'method', 'status_class'], registers })
  const duration = new Histogram({ name: 'magplay_http_request_duration_seconds', help: 'Request lifetime, including streaming', labelNames: ['group'], buckets: [0.01, 0.1, 0.5, 1, 5, 30, 300, 3600], registers })
  const plays = new Counter({ name: 'magplay_playback_attempts_total', help: 'Terminal preparation outcomes', labelNames: ['mode', 'outcome'], registers })
  const ready = new Histogram({ name: 'magplay_playback_ready_seconds', help: 'Successful server preparation, not browser first frame', labelNames: ['mode'], buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 120], registers })
  const jobs = new Counter({ name: 'magplay_jobs_total', help: 'Underlying jobs, excluding joins', labelNames: ['kind', 'outcome'], registers })
  const jobTime = new Histogram({ name: 'magplay_job_duration_seconds', help: 'Underlying job lifetime', labelNames: ['kind'], buckets: [0.1, 1, 5, 30, 120, 600, 7200], registers })
  const rejected = new Counter({ name: 'magplay_resource_rejections_total', help: 'Admission rejections', labelNames: ['resource', 'reason'], registers })
  const usage = new Gauge({ name: 'magplay_resource_in_use', help: 'Occupied slots', labelNames: ['resource'], registers })
  const limits = new Gauge({ name: 'magplay_resource_limit', help: 'Slot limits', labelNames: ['resource'], registers })
  const storage = new Gauge({ name: 'magplay_storage_bytes', help: 'Latest storage snapshot', labelNames: ['kind'], registers })
  const freshness = new Gauge({ name: 'magplay_storage_observed_timestamp_seconds', help: 'Time of the latest successful disk snapshot', registers })
  const entries = new Gauge({ name: 'magplay_cache_entries', help: 'Cached entries', labelNames: ['kind'], registers })
  let previousDrops = 0
  const drops = new Counter({ name: 'magplay_telemetry_dropped_total', help: 'Cumulative application logging losses', registers })
  const metrics: Metrics = {
    http (route, method, status, seconds) {
      const group = oneOf(routeGroup(route), GROUPS)
      requests.inc({ group, method: oneOf(method, ['GET', 'HEAD', 'POST', 'PATCH', 'DELETE']), status_class: status >= 100 && status < 600 ? `${Math.floor(status / 100)}xx` : 'other' })
      duration.observe({ group }, Math.max(0, seconds))
    },
    playback (mode, result, seconds) {
      const m = oneOf(mode, ['direct', 'browser-remux', 'remux', 'transcode', 'unknown'])
      plays.inc({ mode: m, outcome: result })
      if (result === 'success' && m === 'direct') ready.observe({ mode: m }, seconds)
    },
    ready (mode, seconds) { ready.observe({ mode: oneOf(mode, ['direct', 'browser-remux', 'remux', 'transcode']) }, Math.max(0, seconds)) },
    job (kind, result, seconds) { jobs.inc({ kind, outcome: result }); jobTime.observe({ kind }, seconds) },
    reject (resource, reason) { rejected.inc({ resource, reason: oneOf(reason, ['capacity', 'free-space', 'storage']) }) },
  }
  return {
    metrics,
    registry,
    slots (resource: Resource, used: number, limit: number) { usage.set({ resource }, used); limits.set({ resource }, limit) },
    storage (kind: 'free' | 'torrent' | 'hls', bytes: number) { storage.set({ kind }, bytes) },
    observed (at: number) { freshness.set(at / 1000) },
    cache (kind: 'probe' | 'subtitle' | 'links' | 'explore', count: number) { entries.set({ kind }, count) },
    drops (count: number) { drops.inc(Math.max(0, count - previousDrops)); previousDrops = count },
    startRuntime () { stopRuntime ??= collectRuntime(registry) },
    close () { stopRuntime?.(); stopRuntime = undefined; registry.clear() },
  }
}

/** Underlying jobs get independent context; callers log their join separately. */
export async function observeJob<T> (logger: Logger = noopLogger, metrics: Metrics = noopMetrics, kind: JobKind, work: (log: Logger) => Promise<T>, fields: Fields = {}, context?: OperationContext, cancelled: () => boolean = () => false): Promise<T> {
  const jobId = fields.jobId ?? randomUUID()
  context?.logger.info('job.joined', { jobId, jobKind: kind })
  const log = logger.child({ ...fields, jobKind: kind, jobId })
  const started = performance.now()
  log.debug('job.started')
  let result: Outcome = 'success'
  try { return await work(log) } catch (err) {
    result = cancelled() ? 'cancelled' : outcome(err)
    const expected = err instanceof Error && ['SourceError', 'TorrentFailedError'].includes(err.name)
    log[result === 'cancelled' ? 'debug' : result === 'failure' && !expected ? 'error' : 'warn']('job.failed', { outcome: result, err })
    throw err
  } finally {
    const durationMs = performance.now() - started
    metrics.job(kind, result, durationMs / 1000)
    log.debug('job.completed', { outcome: result, durationMs })
  }
}
