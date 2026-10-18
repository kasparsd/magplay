// Fail fast instead of building an unbounded queue of expensive work. A private copy also lives in torrent-engine;
// each throws its own package's busy error.

export interface Limiter {
  <T>(work: () => T | Promise<T>): Promise<T>
  /** Busy slots, for the Debug page. */
  stats: () => { used: number, limit: number }
}

/** `limit` may be a function, so a saved setting applies to the next job. `busy` makes the error thrown when full. */
export function createLimiter (limit: number | (() => number), busy: () => Error): Limiter {
  const max = typeof limit === 'function' ? limit : () => limit
  let active = 0
  const run = async <T>(work: () => T | Promise<T>): Promise<T> => {
    if (active >= max()) throw busy()
    active++
    try { return await work() } finally { active-- }
  }
  return Object.assign(run, { stats: () => ({ used: active, limit: max() }) })
}
