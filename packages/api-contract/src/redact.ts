// Secrets that can hide inside URLs and log text: indexer API keys in query strings and passwords in userinfo.
// Shared so the server's logs and the client's diagnostics remove the same things.

const SECRET_PARAMS = 'apikey|api_key|api-key|jackett_apikey|passkey|token|access_token|key'
const QUERY_SECRET = new RegExp(`([?&](?:${SECRET_PARAMS})=)[^&#\\s"'<>]+`, 'gi')
const USERINFO = /(\b[a-z][a-z\d+.-]*:\/\/[^\s/:@"'<>]*:)[^\s/@"'<>]+@/gi
const HEADER_SECRET = /(\bx-api-key["']?\s*[:=]\s*["']?)[^\s"',}]+/gi

/** `text` with API keys in query strings, URL passwords and X-Api-Key values replaced by `***`. */
export function redactSecrets (text: string): string {
  return text.replace(QUERY_SECRET, '$1***').replace(USERINFO, '$1***@').replace(HEADER_SECRET, '$1***').replace(/(\b(?:authorization|cookie|password|passkey|access_token|token)["']?\s*[:=]\s*["']?)[^\r\n"',}]+/gi, '$1***')
}

/** A JSON-like value with every string passed through redactSecrets(). */
export function redactDeep<T> (value: T): T {
  if (typeof value === 'string') return redactSecrets(value) as T
  if (Array.isArray(value)) return value.map(redactDeep) as T
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, /api.?key|password|passkey|token|authorization|cookie|secret/i.test(k) ? '***' : redactDeep(v)])) as T
  return value
}
