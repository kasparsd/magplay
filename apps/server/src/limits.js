import { HttpError } from './errors.ts'

export const busyError = message => new HttpError(503, message, { retryAfter: 5 })

/**
 * Fail fast instead of building an unbounded queue of expensive work. `limit` may be a function,
 * so a saved setting applies to the next job. `run.stats()` reports busy slots for the Debug page.
 */
export function createLimiter (limit, label) {
  const max = typeof limit === 'function' ? limit : () => limit
  let active = 0
  const run = async work => {
    if (active >= max()) throw busyError(`${label} is busy. Try again shortly.`)
    active++
    try { return await work() } finally { active-- }
  }
  run.stats = () => ({ used: active, limit: max() })
  return run
}
