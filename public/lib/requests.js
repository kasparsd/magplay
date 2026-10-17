/** A timer owned by a request/page lifetime; cancellation clears it immediately. */
export function delay (ms, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason) }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve() }, ms)
    if (signal?.aborted) abort()
    else signal?.addEventListener('abort', abort, { once: true })
  })
}

// Guards UI updates against responses from superseded requests.
export function latestRequest () {
  let generation = 0
  return () => {
    const current = ++generation
    return () => current === generation
  }
}

// Playback requests mutate server-side tab state. Run them in order, skipping
// queued work superseded before it starts (not merely hiding stale responses).
export function serialLatest () {
  let tail = Promise.resolve()
  const begin = latestRequest()
  return task => {
    const current = begin()
    const result = tail.then(() => current() ? task(current) : undefined)
    tail = result.catch(() => {})
    return result
  }
}
