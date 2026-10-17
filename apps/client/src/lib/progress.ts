// Small wire/storage-independent rules. UI recall()/remember() already handle
// blocked/malformed localStorage; retain the existing per-browser namespace.
export const progressKey = (ih: string, idx: string | number): string => `progress:${ih}:${idx}`

export interface ProgressEntry {
  /** Seconds from the start of the file */
  position: number
  duration: number | null
  completed: boolean
  /** When it was saved, ms since the epoch */
  at: number
}

const knownDuration = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
const nearEnd = (position: number, duration: number | null): boolean => duration !== null && duration - position <= Math.min(30, duration * 0.05)

/** Create a per-file record; null means the input is not safe to persist. */
export function progressEntry (position: number, duration: unknown, { ended = false, at = Date.now() } = {}): ProgressEntry | null {
  if (!Number.isFinite(position) || position < 0) return null
  const known = knownDuration(duration)
  if (known !== null) position = Math.min(position, known)
  return { position, duration: known, completed: ended || nearEnd(position, known), at }
}

/**
 * Return a useful absolute resume timestamp, or 0 for restart/no history.
 * `record` comes from storage, so it is checked rather than trusted.
 */
export function resumePosition (record: unknown, duration?: unknown): number {
  if (!record || typeof record !== 'object') return 0
  const { position, completed, duration: saved } = record as Partial<Record<keyof ProgressEntry, unknown>>
  if (completed === true || typeof position !== 'number' || !Number.isFinite(position) || position < 5) return 0
  if (nearEnd(position, knownDuration(duration) ?? knownDuration(saved))) return 0
  return position
}
