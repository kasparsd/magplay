import type { ParsedTorrent } from 'parse-torrent'

/**
 * The announce list to load a torrent with: its own trackers plus the operator's extras.
 * A private torrent keeps only its own, as WebTorrent does for its default trackers: announcing its info hash to
 * public trackers would reveal it and breaks the rules of most private trackers.
 * A magnet link cannot say whether its torrent is private, so extras apply to it until the metadata arrives.
 */
export function announceList (parsed: Pick<ParsedTorrent, 'announce' | 'private'>, extras: readonly string[]): string[] {
  return [...new Set([...(parsed.announce ?? []), ...(parsed.private ? [] : extras)])]
}
