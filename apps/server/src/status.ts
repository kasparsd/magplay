// Status check registry: checks run lazily when /api/status is asked, are cached per TTL so polling
// never hammers indexers, and level changes are kept in a small in-memory ring buffer of events.
import { overallLevel } from '@magplay/api-contract'
import type { StatusAction, StatusCheck, StatusEvent, StatusLevel, StatusResponse } from '@magplay/api-contract'

export interface CheckResult {
  level: StatusLevel
  value?: string
  message?: string
  action?: StatusAction
}

export interface CheckDef {
  id: string
  label: string
  /** Cache lifetime in ms; Infinity runs once (until invalidated). */
  ttl: number
  required?: boolean
  /** Null hides the check (nothing to report, like "no restart needed"). */
  run: (signal: AbortSignal) => Promise<CheckResult | null> | CheckResult | null
}

interface Entry {
  def: CheckDef
  result: CheckResult | null
  at: number
  running: Promise<void> | null
  /** Bumped by invalidate() so a slow, outdated run can't overwrite a newer one. */
  generation: number
}

export interface StatusRegistry {
  registerCheck: (def: CheckDef) => void
  removeChecks: (predicate: (id: string) => boolean) => void
  /** Forgets a cached result, so the next snapshot runs the check again. */
  invalidate: (id: string) => void
  pushEvent: (event: Omit<StatusEvent, 'at'>) => void
  /** Runs stale checks and waits up to `wait` ms; checks still running report unknown and finish in the background. */
  snapshot: (opts?: { wait?: number }) => Promise<StatusResponse>
  events: () => StatusEvent[]
}

export const EVENT_LIMIT = 50

export function createStatus ({ now = Date.now, timeoutMs = 10_000 }: { now?: () => number, timeoutMs?: number } = {}): StatusRegistry {
  const checks = new Map<string, Entry>()
  const events: StatusEvent[] = []

  function pushEvent (event: Omit<StatusEvent, 'at'>): void {
    events.push({ at: now(), ...event })
    if (events.length > EVENT_LIMIT) events.splice(0, events.length - EVENT_LIMIT)
  }

  function record (entry: Entry, result: CheckResult | null): void {
    const before = entry.result?.level
    const after = result?.level
    // A first result is news only when it's a problem; after that, every change is
    if (after && after !== before && (before || after === 'warn' || after === 'error') && after !== 'unknown') {
      const detail = result?.message ?? result?.value ?? after
      const message = after === 'ok' ? `${entry.def.label} is working again` : detail.startsWith(entry.def.label) ? detail : `${entry.def.label}: ${detail}`
      pushEvent({ checkId: entry.def.id, level: after, message })
    }
    entry.result = result
    entry.at = now()
  }

  function start (entry: Entry): Promise<void> {
    if (entry.running) return entry.running
    const generation = entry.generation
    const signal = AbortSignal.timeout(timeoutMs)
    entry.running = (async () => {
      let result: CheckResult | null
      try {
        result = await entry.def.run(signal)
      } catch (err) {
        const message = err instanceof Error ? (err.name === 'TimeoutError' ? `didn’t answer within ${timeoutMs / 1000} s` : err.message) : String(err)
        result = { level: 'error', message }
      }
      if (entry.generation === generation && checks.get(entry.def.id) === entry) record(entry, result)
    })().finally(() => { entry.running = null })
    return entry.running
  }

  const stale = (e: Entry): boolean => !e.at || now() - e.at >= e.def.ttl

  return {
    registerCheck (def) {
      const old = checks.get(def.id)
      // Re-registering (a source edited) keeps the last result, so events still describe changes
      checks.set(def.id, { def, result: old?.result ?? null, at: 0, running: null, generation: (old?.generation ?? 0) + 1 })
    },
    removeChecks (predicate) {
      for (const id of [...checks.keys()]) if (predicate(id)) checks.delete(id)
    },
    invalidate (id) {
      const entry = checks.get(id)
      if (!entry) return
      entry.at = 0
      entry.generation++
      entry.running = null
    },
    pushEvent,
    async snapshot ({ wait = 4000 } = {}) {
      const runs = [...checks.values()].filter(stale).map(start)
      let timer: NodeJS.Timeout | undefined
      await Promise.race([Promise.all(runs), new Promise(resolve => { timer = setTimeout(resolve, wait) })])
      clearTimeout(timer)
      const list: StatusCheck[] = []
      for (const { def, result, at } of checks.values()) {
        if (!result && at) continue // ran, and has nothing to report
        const r = result ?? { level: 'unknown' as const, message: 'Checking…' }
        list.push({
          id: def.id,
          label: def.label,
          required: !!def.required,
          level: r.level,
          ...(r.value !== undefined && { value: r.value }),
          ...(r.message !== undefined && { message: r.message }),
          ...(r.action && { action: r.action }),
          ...(at && { at }),
        })
      }
      return { level: overallLevel(list), checks: list, events: [...events] }
    },
    events: () => [...events],
  }
}
