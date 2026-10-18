// Typed failures; the app decides which HTTP status each one becomes. Messages are written for the user.

/** Not a magnet, info hash or .torrent file. */
export class InvalidTorrentError extends Error {
  override name = 'InvalidTorrentError'
}

/** The torrent has no file at that index. */
export class NoSuchFileError extends Error {
  override name = 'NoSuchFileError'
}

/** No peers sent the metadata in time, or checking cached data took too long. The pending load was dropped. */
export class TorrentTimeoutError extends Error {
  override name = 'TorrentTimeoutError'
}

/** The torrent failed or closed before its file list was ready. */
export class TorrentFailedError extends Error {
  override name = 'TorrentFailedError'
}

/** Too many torrents are loading at once; worth retrying shortly. */
export class EngineBusyError extends Error {
  override name = 'EngineBusyError'
}
