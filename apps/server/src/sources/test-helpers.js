import fs from 'node:fs'

export const fixture = name => fs.readFileSync(new URL(`./test-fixtures/${name}`, import.meta.url), 'utf8')

/**
 * A fetch() stand-in. `handler(url, opts)` returns a Response, or {status, body, headers}.
 * Calls are recorded on `.calls`; a handler that never resolves is cut off by the caller's AbortSignal.
 */
export function mockFetch (handler) {
  const calls = []
  async function fetch (url, opts = {}) {
    const u = new URL(url)
    calls.push({ url: u, opts })
    const reply = await Promise.race([
      handler(u, opts),
      new Promise((resolve, reject) => {
        if (opts.signal?.aborted) reject(opts.signal.reason)
        opts.signal?.addEventListener('abort', () => reject(opts.signal.reason))
      }),
    ])
    if (reply instanceof Response) return reply
    return new Response(reply.body ?? '', { status: reply.status ?? 200, headers: reply.headers })
  }
  fetch.calls = calls
  return fetch
}

export const never = () => new Promise(() => {})

/** A fake source adapter for testing the search layer without HTTP. */
export const fakeSource = (name, impl) => ({ name, search: impl })
