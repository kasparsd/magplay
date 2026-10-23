// Source registry: which adapter handles each kind of indexer. Configs come from the app (env vars and settings).
import { createTorznabSource } from './torznab.ts'
import { createProwlarrSource } from './prowlarr.ts'
import type { Fetch } from './release.ts'
import type { Source } from './source.ts'

interface Common {
  /** The settings item id, for status checks. */
  id?: string
  url: string
  apiKey?: string
}

export type SourceConfig =
  | Common & { type: 'torznab' }
  /** `indexer`: a Jackett indexer id, `all`, or a filter like `tag:tv,!type:private`. */
  | Common & { type: 'jackett', indexer?: string }
  /** `indexerIds`: Prowlarr indexer ids; -2 means every torrent indexer. */
  | Common & { type: 'prowlarr', indexerIds?: string[] }

export type SourceType = SourceConfig['type']
export const SOURCE_TYPES: readonly SourceType[] = ['torznab', 'jackett', 'prowlarr']

const trimSlash = (s: string): string => s.replace(/\/+$/, '')

/** The Torznab feed URL for Jackett: a full feed URL as given, or Jackett's base URL plus an indexer id or filter. */
export const jackettFeedUrl = (url: string, indexer = 'all'): string =>
  /\/torznab(\/api)?\/?$/.test(url) ? url : `${trimSlash(url)}/api/v2.0/indexers/${encodeURIComponent(indexer)}/results/torznab/api`

/** Builds one adapter; `deps` (e.g. a mock fetch) is passed through. Jackett is a Torznab preset. */
export function createSource (config: SourceConfig, deps: { fetch?: Fetch } = {}): Source {
  const { url, apiKey = '' } = config
  const name = new URL(url).hostname
  switch (config.type) {
    case 'torznab': return createTorznabSource({ name, url, apiKey }, deps)
    case 'jackett': return createTorznabSource({ name, url: jackettFeedUrl(url, config.indexer), apiKey }, deps)
    case 'prowlarr': return createProwlarrSource({ name, url, apiKey, ...(config.indexerIds && { indexerIds: config.indexerIds }) }, deps)
  }
}

export const createSources = (configs: readonly SourceConfig[], deps: { fetch?: Fetch } = {}): Source[] =>
  configs.map(c => createSource(c, deps))
