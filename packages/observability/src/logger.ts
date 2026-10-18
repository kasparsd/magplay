import { randomUUID } from 'node:crypto'
import pino from 'pino'
import type { DestinationStream } from 'pino'
import { redactSecrets } from '@magplay/api-contract'
import type { LogRecord, LogLevel } from '@magplay/api-contract'

export type { LogRecord, LogLevel }
export type Fields = Record<string, unknown>
export interface Logger {
  child: (fields: Fields) => Logger
  debug: (event: string, fields?: Fields, msg?: string) => void
  info: (event: string, fields?: Fields, msg?: string) => void
  warn: (event: string, fields?: Fields, msg?: string) => void
  error: (event: string, fields?: Fields, msg?: string) => void
}
export interface Logging {
  logger: Logger
  tail: () => LogRecord[]
  status: () => { level: LogLevel | 'silent', dropped: number }
  flush: () => Promise<void>
}
export const noopLogger: Logger = { child: () => noopLogger, debug () {}, info () {}, warn () {}, error () {} }
const ALLOWED = new Set('component requestId operationId jobId sessionId replacesSessionId torrentId fileIndex sourceId configurationRevision changed durationMs stage mode reason outcome startSeconds audioIndex count bytes used limit freeBytes signal code cacheClass stopReason speed fps outputSeconds port tool err stderr resource jobKind method route status aborted'.split(' '))
const SECRET = /^(?:.*(?:api.?key|password|passkey|token|authorization|cookie|secret).*)$/i
const cut = (s: string, length = 1024): string => [...s.slice(0, length * 2)].slice(0, length).join('')

/** Bounded, non-mutating JSON normalization; never invokes toJSON or getters. */
export function sanitize (value: unknown, depth = 0, seen = new Set<object>()): unknown {
  if (typeof value === 'string') return cut(redactSecrets(value).replace(/\b[a-z][a-z\d+.-]*:\/\/[^\s"'<>]+/gi, '[url]'))
  if (value == null || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'object') return `[${typeof value}]`
  if (depth >= 5) return '[truncated]'
  if (seen.has(value)) return '[circular]'
  seen.add(value)
  try {
    if (value instanceof Error) {
      return sanitize({ type: value.name, message: (sanitize(value.message) as string).replace(/(?:[A-Za-z]:\\|\/)[\w./\\@%+ -]+/g, '[path]'), stack: typeof value.stack === 'string' ? (sanitize(value.stack) as string).replace(/(?:file:\/\/)?(?:[A-Za-z]:\\|\/)[^\s)]+/g, '[path]') : undefined, code: (value as NodeJS.ErrnoException).code, cause: value.cause }, depth + 1, seen)
    }
    if (Array.isArray(value)) return value.slice(0, 16).map(v => sanitize(v, depth + 1, seen))
    const out: Record<string, unknown> = {}
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value)).slice(0, 24)) {
      out[cut(key, 64)] = SECRET.test(key) ? '***' : 'value' in descriptor ? sanitize(descriptor.value, depth + 1, seen) : '[accessor]'
    }
    return out
  } catch { return '[unserializable]' } finally { seen.delete(value) }
}

function approved (fields: Fields): Fields {
  const out: Fields = {}
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(fields))) {
    if (ALLOWED.has(key) && 'value' in descriptor) {
      const value = sanitize(descriptor.value)
      out[key] = key === 'stderr' && typeof value === 'string' ? value.replace(/(?:file:\/\/)?(?:[A-Za-z]:\\|\/)[^\s)]+/g, '[path]') : value
    }
  }
  return out
}

export function createLogging ({ level = 'info', version = 'unknown', sink }: { level?: LogLevel | 'silent', version?: string, sink?: DestinationStream } = {}): Logging {
  const lines: Array<{ record: LogRecord, bytes: number }> = []
  let bytes = 0
  let dropped = 0
  let broken = false
  const destination = sink ?? pino.destination({ dest: 1, sync: false, minLength: 0, maxLength: 1024 ** 2 })
  if ('on' in destination && typeof destination.on === 'function') {
    const events = destination as { on: (event: string, callback: () => void) => void }
    events.on('drop', () => { dropped++ })
    events.on('error', () => { broken = true; dropped++ })
  }
  const base = { service: 'magplay', version: cut(version, 64), runId: randomUUID() }
  const engine = pino({ level, base: null, timestamp: false, serializers: { err: (value: unknown) => value }, formatters: { level: label => ({ level: label }) } }, {
    write (json: string) {
      const record = JSON.parse(json) as LogRecord
      const size = Buffer.byteLength(json)
      lines.push({ record, bytes: size }); bytes += size
      while (lines.length > 200 || bytes > 512 * 1024) bytes -= lines.shift()!.bytes
      if (broken) { dropped++; return }
      try { destination.write(json) } catch { broken = true; dropped++ }
    },
  })
  function make (bindings: Fields): Logger {
    const emit = (severity: LogLevel, event: string, fields: Fields = {}, msg = event): void => {
      if (!engine.isLevelEnabled(severity)) return
      let record: Fields = { ...base, ...bindings, ...approved(fields), time: new Date().toISOString(), event: cut(event, 128), msg: sanitize(msg) }
      if (Buffer.byteLength(JSON.stringify(record)) > 7900) {
        const { component, requestId, operationId, jobId, sessionId, durationMs, outcome, mode, time, event } = record
        record = { ...base, component, requestId, operationId, jobId, sessionId, durationMs, outcome, mode, time, event, msg: '[record truncated]', err: '[truncated]' }
      }
      engine[severity](record)
    }
    return {
      child: fields => make({ ...bindings, ...approved(fields) }),
      debug: (e, f, m) => emit('debug', e, f, m),
      info: (e, f, m) => emit('info', e, f, m),
      warn: (e, f, m) => emit('warn', e, f, m),
      error: (e, f, m) => emit('error', e, f, m),
    }
  }
  return {
    logger: make({ component: 'server' }),
    tail: () => lines.map(({ record }) => structuredClone(record)),
    status: () => ({ level, dropped }),
    async flush () {
      if (!('flush' in destination) || typeof destination.flush !== 'function' || broken) return
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, 500)
        const flush = destination.flush as (callback: () => void) => void
        try { flush.call(destination, () => { clearTimeout(timer); resolve() }) } catch { clearTimeout(timer); resolve() }
      })
    },
  }
}
