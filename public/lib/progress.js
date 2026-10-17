// Small wire/storage-independent rules. UI recall()/remember() already handle
// blocked/malformed localStorage; retain the existing per-browser namespace.
export const progressKey = (ih, idx) => `progress:${ih}:${idx}`

const knownDuration = value => Number.isFinite(value) && value > 0 ? value : null
const nearEnd = (position, duration) => duration !== null && duration - position <= Math.min(30, duration * 0.05)

/** Create a per-file record; null means the input is not safe to persist. */
export function progressEntry (position, duration, { ended = false, at = Date.now() } = {}) {
  if (!Number.isFinite(position) || position < 0) return null
  duration = knownDuration(duration)
  if (duration !== null) position = Math.min(position, duration)
  return { position, duration, completed: ended || nearEnd(position, duration), at }
}

/** Return a useful absolute resume timestamp, or 0 for restart/no history. */
export function resumePosition (record, duration) {
  if (!record || typeof record !== 'object' || record.completed === true ||
      !Number.isFinite(record.position) || record.position < 5) return 0
  duration = knownDuration(duration) ?? knownDuration(record.duration)
  if (nearEnd(record.position, duration)) return 0
  return record.position
}
