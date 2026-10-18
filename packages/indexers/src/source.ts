// What every search source adapter provides.
import type { Release } from './release.ts'

export interface SearchOptions {
  /** A Torznab category id, e.g. 5000 for TV. */
  cat?: string | undefined
  signal: AbortSignal
}

export interface CheckOptions {
  signal?: AbortSignal
}

export interface Source {
  name: string
  search: (q: string, options: SearchOptions) => Promise<Release[]>
  /** A cheap request for the status menu; throws a SourceError when the source isn't usable. */
  check: (options?: CheckOptions) => Promise<void>
}
