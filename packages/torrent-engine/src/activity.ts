// A loaded torrent's live numbers: speeds, peers and which parts of a file are on disk.
import type { Torrent as WtTorrent, TorrentFile as WtFile, Wire } from 'webtorrent'

export interface PeerActivity {
  address: string | null
  client: string | null
  type?: string
  downloadSpeed: number
  uploadSpeed: number
  downloaded: number
  uploaded: number
  /** Fraction of pieces the peer has. */
  share: number
  /** Not sending to us right now. */
  choking: boolean
}

export type TorrentActivity = { loaded: false } | {
  loaded: true
  activeStreams: number
  downloadSpeed: number
  uploadSpeed: number
  downloaded: number
  length: number
  progress: number
  files: Array<{ idx: number, progress: number }>
  peers: PeerActivity[]
  /** The watched file's progress and downloaded parts as [from, to] fractions of its length. */
  file?: { idx: number, progress: number, ranges: Array<[number, number]> }
}

/** Downloaded parts of a file as [from, to] fractions of its length. */
function fileRanges (t: WtTorrent, file: WtFile): Array<[number, number]> {
  const n = file._endPiece - file._startPiece + 1
  const ranges: Array<[number, number]> = []
  let runStart = -1
  for (let i = 0; i <= n; i++) {
    const have = i < n && t.bitfield.get(file._startPiece + i)
    if (have && runStart < 0) runStart = i
    if (!have && runStart >= 0) { ranges.push([runStart / n, i / n]); runStart = -1 }
  }
  return ranges
}

/** How much of the torrent a peer has, from its piece bitfield (seeders announce "have all" without one). */
function peerShare (wire: Wire, pieces: number): number {
  const bits = wire.peerPieces
  if (bits?.constructor.name === 'HaveAllBitField') return 1
  let have = 0
  for (const byte of bits?.buffer?.subarray(0, Math.ceil(pieces / 8)) ?? []) {
    for (let b = byte; b; b >>= 1) have += b & 1
  }
  return pieces ? Math.min(1, have / pieces) : 0
}

const decoder = new TextDecoder()

const address = (w: Wire): string | null =>
  !w.remoteAddress ? null : w.remoteAddress.includes(':') ? `[${w.remoteAddress}]:${w.remotePort}` : `${w.remoteAddress}:${w.remotePort}`

export function activity (t: WtTorrent, activeStreams: number, idx?: number): TorrentActivity {
  const pieces = t.pieces.length
  const peers = t.wires.map((w): PeerActivity => ({
    address: address(w),
    client: w.peerExtendedHandshake?.v ? decoder.decode(w.peerExtendedHandshake.v).slice(0, 40) : null,
    ...(w.type !== undefined && { type: w.type }),
    downloadSpeed: w.downloadSpeed(),
    uploadSpeed: w.uploadSpeed(),
    downloaded: w.downloaded,
    uploaded: w.uploaded,
    share: peerShare(w, pieces),
    choking: w.peerChoking,
  })).sort((a, b) => b.downloadSpeed - a.downloadSpeed || b.downloaded - a.downloaded)
  const file = idx !== undefined ? t.files[idx] : undefined
  return {
    loaded: true,
    activeStreams,
    downloadSpeed: t.downloadSpeed,
    uploadSpeed: t.uploadSpeed,
    downloaded: t.downloaded,
    length: t.length,
    progress: t.progress,
    files: t.files.map((f, i) => ({ idx: i, progress: f.done ? 1 : f.progress })),
    peers,
    ...(file && idx !== undefined && { file: { idx, progress: file.done ? 1 : file.progress, ranges: fileRanges(t, file) } }),
  }
}
