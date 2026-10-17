import { httpError } from './config.js'

export const busyError = message => Object.assign(httpError(503, message), { retryAfter: 5 })

/** Fail fast instead of building an unbounded queue of expensive work. */
export function createLimiter (limit, label) {
  let active = 0
  return async work => {
    if (active >= limit) throw busyError(`${label} is busy. Try again shortly.`)
    active++
    try { return await work() } finally { active-- }
  }
}
