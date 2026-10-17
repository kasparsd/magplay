// JSON API transport only: no DOM, storage, URL rewriting or implicit retries.

/** HTTP or invalid-JSON failure; native fetch/abort errors pass through unchanged. */
export class ApiError extends Error {
  override name = 'ApiError'
  readonly status: number

  constructor (message: string, status: number, options?: ErrorOptions) {
    super(message, options)
    this.status = status
  }
}

/** `json` supplies a JSON body and defaults the method to POST. */
export type ApiOptions = RequestInit & { json?: unknown }

/**
 * Fetch parsed JSON. Relative URLs stay on the page's origin; fetch options,
 * including AbortSignal and cache policy, are forwarded without added defaults.
 * JSON requests preserve caller headers but set Content-Type to application/json.
 *
 * Successful responses must contain JSON (including null/arrays); malformed or
 * empty success bodies throw an ApiError with the response status. HTTP failures
 * use a string `error` from the server, or HTTP <status> for non-JSON/error pages.
 * Network, body-stream and abort failures retain their original error/reason.
 * Response shapes are documented in @magplay/api-contract, not validated by this helper.
 */
export async function api<T = unknown> (url: RequestInfo | URL, { json, ...opts }: ApiOptions = {}): Promise<T> {
  if (json !== undefined) {
    const headers = new Headers(opts.headers)
    headers.set('Content-Type', 'application/json')
    Object.assign(opts, { method: opts.method ?? 'POST', headers, body: JSON.stringify(json) })
  }
  const res = await fetch(url, opts)
  let body: unknown
  try {
    body = await res.json()
  } catch (err) {
    // A body read may be cancelled after headers arrive. Never turn that into
    // an HTTP/parse error (including custom abort reasons such as SyntaxError).
    if (opts.signal?.aborted || !(err instanceof SyntaxError)) throw err
    if (res.ok) throw new ApiError('Invalid JSON response', res.status, { cause: err })
  }
  if (!res.ok) {
    const error = body && typeof body === 'object' && 'error' in body ? body.error : undefined
    throw new ApiError(typeof error === 'string' && error ? error : `HTTP ${res.status}`, res.status)
  }
  return body as T
}
