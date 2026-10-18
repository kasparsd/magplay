import fs from 'node:fs'
import type { Release } from './release.ts'
import type { SearchOptions, Source } from './source.ts'

export const fixture = (name: string): string => fs.readFileSync(new URL(`./test-fixtures/${name}`, import.meta.url), 'utf8')

export interface MockReply { status?: number, body?: string | Uint8Array | null, headers?: Record<string, string> }
export type MockHandler = (url: URL, opts: RequestInit) => MockReply | Response | undefined | Promise<MockReply | Response | undefined>
export interface Call { url: URL, opts: RequestInit & { headers?: Record<string, string>, body?: string } }
export type MockFetch = ((url: string | URL, opts?: RequestInit) => Promise<Response>) & { calls: Call[] }

/**
 * A fetch() stand-in. `handler(url, opts)` returns a Response, or {status, body, headers}.
 * Calls are recorded on `.calls`; a handler that never resolves is cut off by the caller's AbortSignal.
 */
export function mockFetch (handler: MockHandler): MockFetch {
  const calls: Call[] = []
  async function fetch (url: string | URL, opts: RequestInit = {}): Promise<Response> {
    const u = new URL(url)
    calls.push({ url: u, opts: opts as Call['opts'] })
    const { signal } = opts
    const reply = await Promise.race([
      handler(u, opts),
      new Promise<never>((_resolve, reject) => {
        if (signal?.aborted) reject(signal.reason as Error)
        signal?.addEventListener('abort', () => reject(signal.reason as Error))
      }),
    ])
    if (reply instanceof Response) return reply
    return new Response(reply?.body ?? '', { status: reply?.status ?? 200, ...(reply?.headers && { headers: reply.headers }) })
  }
  return Object.assign(fetch, { calls })
}

export const never = (): Promise<never> => new Promise(() => {})

/** A fake source adapter for testing the search layer without HTTP; `search` may return or throw synchronously. */
export const fakeSource = (name: string, search: (q: string, opts: SearchOptions) => Release[] | Promise<Release[]>): Source =>
  ({ name, search: (q, opts) => Promise.resolve().then(() => search(q, opts)), check: () => Promise.resolve() })
