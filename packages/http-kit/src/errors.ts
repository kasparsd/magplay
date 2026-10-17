// Typed failures; the app decides which HTTP status each one becomes.

/** The request path can't be decoded (bad percent encoding). */
export class MalformedPathError extends Error {
  override name = 'MalformedPathError'
}

/** The file to serve doesn't exist or isn't a regular file. */
export class FileNotFoundError extends Error {
  override name = 'FileNotFoundError'
}
