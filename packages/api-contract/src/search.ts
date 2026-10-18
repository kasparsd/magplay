// GET /api/search and the torrent endpoints: POST /api/torrents, GET /api/torrents/:ih, GET /api/recent.

/** One merged result. Download links stay on the server; `linkId` adds the torrent by it. */
export interface SearchResult {
  title: string
  /** 40-char lowercase hex. */
  infoHash: string | null
  magnet: string | null
  linkId: string | null
  /** Bytes. */
  size: number | null
  seeders: number | null
  /** Where it was found, e.g. ["Prowlarr/ExampleIndexer"]. */
  sources: string[]
  badges: string[]
  /** A guess whether the browser plays it without ffmpeg work. */
  likelyDirect: boolean
  /** A note for programs and archives, or a warning from a file list seen earlier. */
  warning: string | null
}

export type SourceReport =
  | { name: string, ok: true, count: number, ms: number }
  | { name: string, ok: false, error: string, ms: number }

/** GET /api/search?q&cat. */
export interface SearchResponse {
  results: SearchResult[]
  sources: SourceReport[]
}

/** POST /api/torrents: one of the three. */
export interface AddTorrentRequest {
  infoHash?: string
  magnet?: string
  linkId?: string
}

export interface TorrentFileInfo {
  idx: number
  name: string
  /** Bytes. */
  size: number
  isVideo: boolean
  isSub: boolean
  isProgram: boolean
  season: number | null
  episode: number | null
}

/** POST /api/torrents and GET /api/torrents/:ih. */
export interface TorrentInfo {
  infoHash: string
  name: string
  files: TorrentFileInfo[]
  warning: string | null
}

/** GET /api/recent: torrents in the cache, most recently used first. */
export interface RecentTorrent {
  infoHash: string
  name: string | null
  /** Bytes, from the metadata. */
  length: number | null
  /** ms since the epoch. */
  lastUsed: number
  /** Bytes on the server's disk. */
  onDisk: number
}
