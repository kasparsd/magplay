// Typed failures; the app decides which HTTP status each one becomes. Messages are written for the user.

/** A source answered but failed, or couldn't be reached; `message` is shown next to the source name. */
export class SourceError extends Error {
  override name = 'SourceError'
}

/** No source is configured, so there is nothing to search. */
export class NoSourcesError extends Error {
  override name = 'NoSourcesError'
}

/** A source (BitMagnet for Explore) didn't answer in time. */
export class SearchTimeout extends Error {
  override name = 'SearchTimeout'
}

/** A search result's private download link id is no longer known (evicted, or from before a restart). */
export class LinkExpired extends Error {
  override name = 'LinkExpired'
}

/** fetch() and AbortSignal.timeout() abort with these names. */
export const isAbort = (err: unknown): boolean => err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')

export const errorMessage = (err: unknown): string => err instanceof Error ? err.message : String(err)

/** The system error code a fetch() failure carries in `cause` (ECONNREFUSED…), else its message. */
export function fetchFailure (err: unknown): string {
  const cause = err instanceof Error ? err.cause : undefined
  const code = cause && typeof cause === 'object' && 'code' in cause && typeof cause.code === 'string' ? cause.code : undefined
  return code || errorMessage(err)
}
