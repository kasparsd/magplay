// The parts of parse-torrent 11 this package uses. It ships no types, and DefinitelyTyped targets older majors.
declare module 'parse-torrent' {
  export interface ParsedTorrent {
    infoHash: string
    name?: string
    length?: number
    files?: { name: string, path: string, length: number }[]
    announce?: string[]
    created?: Date
    /** The bencoded info dictionary, present when parsed from a .torrent file. */
    info?: Record<string, unknown>
  }

  /** A magnet URI, info hash or .torrent file to its parts; throws (or rejects) on anything else. */
  export default function parseTorrent (torrentId: string | Uint8Array | ParsedTorrent): Promise<ParsedTorrent>
  /** A parsed torrent (with `info`) back to .torrent file bytes. */
  export function toTorrentFile (parsed: { info: Record<string, unknown>, announce?: string[], created?: Date }): Uint8Array
}
