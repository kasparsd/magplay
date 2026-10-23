// Server data for the vanilla pages: newest-wins requests, a keyed cache and visibility-aware polling.
// No DOM rendering here, so every rule is tested in Node. Pages own what they draw; these own when and whether.

/**
 * Starts a new request lifetime and aborts the previous one, so a superseded fetch is cancelled, not just ignored.
 * After an await, `signal.aborted` means a newer request (or the page) took over: draw nothing.
 */
export function takeLatest (parent?: AbortSignal): () => AbortSignal {
  let controller: AbortController | null = null
  return () => {
    controller?.abort()
    controller = new AbortController()
    return parent ? AbortSignal.any([parent, controller.signal]) : controller.signal
  }
}

interface Entry { at: number, value: unknown }

/** Where `cached()` keeps values. sessionStorage survives Back to this page; a Map lasts the page. */
export interface CacheStore {
  get: (key: string) => Entry | undefined
  set: (key: string, entry: Entry) => void
  delete: (key: string) => void
  keys: () => Iterable<string>
}

export function memoryStore (): CacheStore {
  const map = new Map<string, Entry>()
  return { get: k => map.get(k), set: (k, e) => { map.set(k, e) }, delete: k => { map.delete(k) }, keys: () => map.keys() }
}

/** sessionStorage under "magplay:cache:<key>"; blocked or full storage behaves like an empty cache. */
export function sessionStore (storage: Storage | undefined = globalThis.sessionStorage): CacheStore {
  const prefix = 'magplay:cache:'
  return {
    get: k => { try { return (JSON.parse(storage?.getItem(prefix + k) ?? 'null') as Entry | null) ?? undefined } catch { return undefined } },
    set: (k, e) => { try { storage?.setItem(prefix + k, JSON.stringify(e)) } catch {} },
    delete: k => { try { storage?.removeItem(prefix + k) } catch {} },
    keys: () => {
      const out: string[] = []
      try {
        for (let i = 0; i < (storage?.length ?? 0); i++) {
          const k = storage?.key(i)
          if (k?.startsWith(prefix)) out.push(k.slice(prefix.length))
        }
      } catch {}
      return out
    },
  }
}

export interface CacheOptions {
  /** How long a value is served without asking the server again. 0 always loads (but still shares in-flight work). */
  staleMs?: number
  signal?: AbortSignal
}

export interface Cache {
  /** The value for `key`: fresh from the cache, from a request already in flight, or from `load`. */
  get: <T>(key: string, load: (signal: AbortSignal) => Promise<T>, options?: CacheOptions) => Promise<T>
  /** A cached value regardless of age, to draw at once while a fresh one loads. */
  peek: <T>(key: string) => T | undefined
  /** Forgets every key that starts with `prefix`, after a write that changes them. */
  invalidate: (prefix: string) => void
}

export function createCache (store: CacheStore = memoryStore(), now: () => number = Date.now): Cache {
  const inflight = new Map<string, Promise<unknown>>()
  return {
    get: async <T>(key: string, load: (signal: AbortSignal) => Promise<T>, { staleMs = 0, signal }: CacheOptions = {}) => {
      const hit = store.get(key)
      if (hit && staleMs > 0 && now() - hit.at < staleMs) return hit.value as T
      let pending = inflight.get(key) as Promise<T> | undefined
      if (!pending) {
        // A shared request is not cancelled by one caller leaving; each caller stops waiting on its own signal.
        pending = load(new AbortController().signal)
          .then(value => { store.set(key, { at: now(), value }); return value })
          .finally(() => inflight.delete(key))
        inflight.set(key, pending)
      }
      return signal ? abortable(pending, signal) : pending
    },
    peek: <T>(key: string) => store.get(key)?.value as T | undefined,
    invalidate: prefix => {
      for (const key of [...store.keys()]) if (key.startsWith(prefix)) store.delete(key)
    },
  }
}

function abortable<T> (promise: Promise<T>, signal: AbortSignal): Promise<T> {
  // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- callers check for their own abort reason
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise((resolve, reject) => {
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- as above
    const abort = (): void => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

/** What poll() needs from the page; tests pass a fake. */
export interface PollHost {
  hidden: () => boolean
  onVisible: (listener: () => void, signal: AbortSignal) => void
  setTimeout: (fn: () => void, ms: number) => unknown
  clearTimeout: (id: unknown) => void
}

const pageHost = (): PollHost => ({
  hidden: () => document.hidden,
  onVisible: (listener, signal) => {
    document.addEventListener('visibilitychange', () => { if (!document.hidden) listener() }, { signal })
    addEventListener('focus', listener, { signal })
  },
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: id => { clearTimeout(id as ReturnType<typeof setTimeout>) },
})

export interface PollOptions {
  everyMs: number
  /** Stops polling for good (the page or its owner going away). */
  signal?: AbortSignal
  /** Extra condition, such as "the section is on screen". Checked before every run. */
  when?: () => boolean
  /** Runs started closer together than this (focus, visibility, now()) are skipped. */
  minGapMs?: number
  host?: PollHost
}

export interface Poller {
  /** Runs now unless a run is in flight or ran within minGapMs. */
  now: () => void
}

/**
 * Runs `task` now and then `everyMs` after each run finishes, never two at once. Hidden tabs and a false `when`
 * skip runs; the tab becoming visible runs at once. Errors are the task's to show; polling continues.
 */
export function poll (task: (signal: AbortSignal) => Promise<unknown>, { everyMs, signal, when = () => true, minGapMs = 0, host = pageHost() }: PollOptions): Poller {
  const stop = signal ?? new AbortController().signal
  let running = false
  let last = -Infinity
  let timer: unknown = null
  const schedule = (): void => {
    host.clearTimeout(timer)
    if (!stop.aborted) timer = host.setTimeout(run, everyMs)
  }
  function run (): void {
    if (stop.aborted || running) return
    if (host.hidden() || !when() || Date.now() - last < minGapMs) {
      schedule()
      return
    }
    running = true
    last = Date.now()
    task(stop).catch(() => {}).finally(() => {
      running = false
      schedule()
    })
  }
  stop.addEventListener('abort', () => { host.clearTimeout(timer) }, { once: true })
  host.onVisible(run, stop)
  run()
  return { now: run }
}
