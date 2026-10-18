// Indexer sources (Torznab, Jackett, Prowlarr), parallel search with merged results, download links,
// and BitMagnet's GraphQL browser for Explore. Configs and fetch come in; no env vars or HTTP statuses.
export { LinkExpired, NoSourcesError, SearchTimeout, SourceError } from './errors.ts'
export { release } from './release.ts'
export type { Fetch, RawRelease, Release } from './release.ts'
export type { CheckOptions, SearchOptions, Source } from './source.ts'
export { createTorznabSource, parseTorznabCaps, parseTorznabFeed } from './torznab.ts'
export type { TorznabOptions } from './torznab.ts'
export { createProwlarrSource, parseProwlarrResults } from './prowlarr.ts'
export type { ProwlarrOptions } from './prowlarr.ts'
export { SOURCE_TYPES, createSource, createSources, jackettFeedUrl } from './sources.ts'
export type { SourceConfig, SourceType } from './sources.ts'
export { createSearch, decodeEntities } from './search.ts'
export type { Search, SearchResponse, SearchResult, SourceReport } from './search.ts'
export { resolveLink } from './links.ts'
export { TITLE_SEARCH_LIMIT, TYPES, createBitmagnetBrowser, groupTitles, isContentType, parseSearchResponse, toRelease, toTitle } from './bitmagnet.ts'
export type {
  BitmagnetBrowser, BitmagnetItem, BrowseOptions, ContentType, ExploreRelease, ExploreTitle, ExploreTitleInfo,
  FacetCount, FacetFilter, Facets, LatestRelease, TitleQuery, TitleReleases,
} from './bitmagnet.ts'
