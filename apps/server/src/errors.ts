// The one place errors become HTTP responses. Packages throw their own typed errors and never see a status;
// app modules that haven't moved into a package yet throw HttpError directly.
import { FileNotFoundError, MalformedPathError } from '@magplay/http-kit'
import { LinkExpired, NoSourcesError, SearchTimeout, SourceError } from '@magplay/indexers'

/** An error with an HTTP status, shown to the user as-is. */
export class HttpError extends Error {
  override name = 'HttpError'
  readonly status: number
  /** Seconds, sent as Retry-After. */
  readonly retryAfter: number | undefined

  constructor (status: number, message: string, options: { retryAfter?: number, cause?: unknown } = {}) {
    super(message, 'cause' in options ? { cause: options.cause } : undefined)
    this.status = status
    this.retryAfter = options.retryAfter
  }
}

export interface HttpFailure {
  status: number
  message: string
  retryAfter: number | undefined
  /** Not a known failure: a bug or an unhandled case, worth logging. */
  unexpected: boolean
}

export function toHttpError (err: unknown): HttpFailure {
  const known = (status: number, message: string, retryAfter?: number): HttpFailure => ({ status, message, retryAfter, unexpected: false })
  if (err instanceof HttpError) return known(err.status, err.message, err.retryAfter)
  if (err instanceof MalformedPathError) return known(400, err.message)
  if (err instanceof FileNotFoundError) return known(404, err.message)
  if (err instanceof SourceError) return known(502, err.message)
  if (err instanceof NoSourcesError) return known(503, err.message)
  if (err instanceof SearchTimeout) return known(504, err.message)
  if (err instanceof LinkExpired) return known(410, err.message)
  return { status: 500, message: err instanceof Error ? err.message : String(err), retryAfter: undefined, unexpected: true }
}
