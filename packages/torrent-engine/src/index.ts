// BitTorrent for magplay: one engine per process, created with createTorrentEngine(options) and released by close().
// Files expose cancellable range reads; HTTP serving belongs to the app.
export { createTorrentEngine, DEFAULT_LIVE } from './engine.ts'
export { readMagnet } from './magnet.ts'
export type { LiveOptions, Torrent, TorrentEngine, TorrentEngineOptions, TorrentFile, TorrentInfo } from './engine.ts'
export type { PeerActivity, TorrentActivity } from './activity.ts'
export type { RecentTorrent } from './store.ts'
export { EngineBusyError, InvalidTorrentError, NoSuchFileError, TorrentFailedError, TorrentTimeoutError } from './errors.ts'
