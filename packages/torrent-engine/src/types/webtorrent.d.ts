// The parts of WebTorrent 3 this package uses. DefinitelyTyped's @types/webtorrent describes v1/v2, whose
// file streaming API differs (no async iterator), so these declarations cover only what engine.ts touches.
declare module 'webtorrent' {
  import type { EventEmitter } from 'node:events'
  import type { ParsedTorrent } from 'parse-torrent'

  export interface ClientOptions {
    torrentPort?: number
    dhtPort?: number
    dht?: boolean
    lsd?: boolean
    natUpnp?: boolean
    natPmp?: boolean
    utp?: boolean
  }

  export interface BitField {
    get: (index: number) => boolean
    buffer?: Uint8Array
  }

  export interface Wire {
    remoteAddress?: string
    remotePort?: number
    type?: string
    peerExtendedHandshake?: { v?: Uint8Array }
    peerPieces?: BitField
    peerChoking: boolean
    downloaded: number
    uploaded: number
    downloadSpeed: () => number
    uploadSpeed: () => number
  }

  export interface TorrentFile {
    name: string
    path: string
    length: number
    type: string
    done: boolean
    progress: number
    /** Internal, but the only way to map a file onto the torrent's piece bitfield. */
    _startPiece: number
    _endPiece: number
    /** Bytes start..end (inclusive). end 0 reads to the end of the file. */
    [Symbol.asyncIterator]: (opts?: { start?: number, end?: number }) => AsyncIterator<Uint8Array, undefined>
  }

  export interface Torrent extends EventEmitter {
    infoHash: string
    name?: string
    ready: boolean
    done?: boolean
    metadata?: unknown
    numPeers: number
    files: TorrentFile[]
    torrentFile: Uint8Array
    created?: Date
    pieces: unknown[]
    bitfield: BitField
    getFileModtimes: (cb: (err: Error | null, modtimes?: number[]) => void) => void
    wires: Wire[]
    length: number
    downloaded: number
    downloadSpeed: number
    /** Bytes sent to peers since this torrent was added; starts at 0 on every add. */
    uploaded: number
    uploadSpeed: number
    progress: number
    destroy: (cb?: (err?: Error | null) => void) => void
  }

  export default class WebTorrent extends EventEmitter {
    constructor (opts?: ClientOptions)
    torrents: Torrent[]
    destroyed: boolean
    /** Bytes/s for every torrent together; -1 turns the throttle off, 0 stops uploads. */
    throttleUpload: (rate: number) => void
    add: (torrentId: ParsedTorrent | string | Uint8Array, opts?: { path?: string, deselect?: boolean, fileModtimes?: number[] }) => Torrent
    destroy: (cb?: (err?: Error | null) => void) => void
  }
}
