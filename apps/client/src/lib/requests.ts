/** A timer owned by a request/page lifetime; cancellation clears it immediately. */
export function delay (ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = (): void => {
      clearTimeout(timer)
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- callers check for their own abort reason
      reject(signal?.reason)
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort)
      resolve()
    }, ms)
    if (signal?.aborted) abort()
    else signal?.addEventListener('abort', abort, { once: true })
  })
}

/** True while the request it was handed to is still the newest. */
export type IsCurrent = () => boolean

// Guards UI updates against responses from superseded requests.
export function latestRequest (): () => IsCurrent {
  let generation = 0
  return () => {
    const current = ++generation
    return () => current === generation
  }
}

// Playback requests mutate server-side tab state. Run them in order, skipping
// queued work superseded before it starts (not merely hiding stale responses).
export function serialLatest (): <T>(task: (current: IsCurrent) => T | Promise<T>) => Promise<T | undefined> {
  let tail: Promise<unknown> = Promise.resolve()
  const begin = latestRequest()
  return task => {
    const current = begin()
    const result = tail.then(() => current() ? task(current) : undefined)
    tail = result.catch(() => {})
    return result
  }
}
