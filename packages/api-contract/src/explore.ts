// Explore: GET /api/explore, /api/explore/facets, /api/explore/latest and /api/title/:type/:source/:id (BitMagnet).

export type ExploreType = 'movie' | 'tv_show'

export interface ExploreRelease {
  infoHash: string
  name: string
  size: number | null
  seeders: number | null
  /** BitMagnet's episode label, e.g. "S01E02". */
  episode: string | null
  publishedAt: string | null
  badges: string[]
  likelyDirect: boolean
  warning: string | null
}

export interface TitleInfo {
  type: string
  /** Metadata source and id, e.g. tmdb / 900001. */
  source: string
  id: string
  title: string
  year: number | null
  rating: number | null
  /** Minutes. */
  runtime: number | null
  overview: string | null
  genres: string[]
  links: Array<{ source: string, url: string }>
}

export interface ExploreTitle extends TitleInfo {
  seeders: number | null
  playable: boolean
  /** Info hash of the release to play. */
  best: string
}

/** GET /api/explore?type&genre&year&res&sort&page. */
export interface ExploreResponse {
  titles: ExploreTitle[]
  hasMore: boolean
}

export interface FacetCount {
  value: string | number | null
  count: number
  /** BitMagnet only estimated this count. */
  estimate?: true
}

/** GET /api/explore/facets. */
export interface ExploreFacets {
  genres: Array<FacetCount & { label: string | null }>
  years: FacetCount[]
  resolutions: FacetCount[]
}

/** GET /api/explore/latest: an array of these. */
export interface LatestRelease extends ExploreRelease {
  title: TitleInfo | null
}

/** GET /api/title/:type/:source/:id?title&year. */
export interface TitleResponse extends TitleInfo {
  releases: ExploreRelease[]
  /** More releases matched than were read. */
  truncated: boolean
}
