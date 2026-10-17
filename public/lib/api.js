// JSON API transport only: no DOM, storage, URL rewriting or implicit retries.

/** @typedef {{error: string}} ApiErrorBody HTTP error response from the server. */
/** @typedef {Error & {status: number}} ApiError HTTP or invalid-JSON failure; native fetch/abort errors pass through unchanged. */
/** @typedef {RequestInit & {json?: unknown}} ApiOptions `json` supplies a JSON body and defaults the method to POST. */

/**
 * Fetch parsed JSON. Relative URLs stay on the page's origin; fetch options,
 * including AbortSignal and cache policy, are forwarded without added defaults.
 * JSON requests preserve caller headers but set Content-Type to application/json.
 *
 * Successful responses must contain JSON (including null/arrays); malformed or
 * empty success bodies throw an ApiError with the response status. HTTP failures
 * use a string `error` from the server, or HTTP <status> for non-JSON/error pages.
 * Network, body-stream and abort failures retain their original error/reason.
 * Response shapes are documented in api-types.js, not validated by this helper.
 *
 * @template T
 * @param {RequestInfo | URL} url
 * @param {ApiOptions} [options]
 * @returns {Promise<T>}
 */
export async function api (url, { json, ...opts } = {}) {
  if (json !== undefined) {
    const headers = new Headers(opts.headers)
    headers.set('Content-Type', 'application/json')
    Object.assign(opts, { method: opts.method ?? 'POST', headers, body: JSON.stringify(json) })
  }
  const res = await fetch(url, opts)
  let body
  try {
    body = await res.json()
  } catch (err) {
    // A body read may be cancelled after headers arrive. Never turn that into
    // an HTTP/parse error (including custom abort reasons such as SyntaxError).
    if (opts.signal?.aborted || !(err instanceof SyntaxError)) throw err
    if (res.ok) throw Object.assign(new Error('Invalid JSON response', { cause: err }), { status: res.status })
  }
  if (!res.ok) {
    const message = typeof body?.error === 'string' && body.error ? body.error : `HTTP ${res.status}`
    throw Object.assign(new Error(message), { status: res.status })
  }
  return body
}
