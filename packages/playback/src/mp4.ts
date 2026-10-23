// ISO BMFF (MP4) boxes: the init segment and fragments ffmpeg streams for HLS, and the sample tables of an
// MP4 file's video track, for its keyframe times. Only the boxes these need are read.

/** A box inside `bytes`: its type and where its payload starts and ends. */
export interface Box {
  type: string
  /** Offset of the box header. */
  start: number
  /** Offset of the payload, after the header. */
  body: number
  /** Offset just past the box. */
  end: number
}

const text = new TextDecoder('latin1')

/** The size and type of the box whose header starts at `at`, or null when the header doesn't fit in `bytes`. */
export function boxHeader (bytes: Uint8Array, at: number): { type: string, size: number, header: number } | null {
  if (at + 8 > bytes.length) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let size = view.getUint32(at)
  const type = text.decode(bytes.subarray(at + 4, at + 8))
  let header = 8
  if (size === 1) {
    if (at + 16 > bytes.length) return null
    size = Number(view.getBigUint64(at + 8))
    header = 16
  }
  return { type, size, header }
}

/** The boxes directly inside `bytes[from, to)`; stops at a box that is cut off or malformed. A size of 0 runs to `to`. */
export function * boxes (bytes: Uint8Array, from = 0, to = bytes.length): Generator<Box> {
  let at = from
  while (at < to) {
    const h = boxHeader(bytes, at)
    if (!h) return
    const end = h.size === 0 ? to : at + h.size
    if (h.size !== 0 && h.size < h.header) return
    if (end > to) return
    yield { type: h.type, start: at, body: at + h.header, end }
    at = end
  }
}

/** The first box at `path` (e.g. ['moov', 'trak', 'mdia']) under `parent`, or null. */
export function child (bytes: Uint8Array, parent: Pick<Box, 'body' | 'end'>, ...path: string[]): Box | null {
  let current: Pick<Box, 'body' | 'end'> | null = parent
  let found: Box | null = null
  for (const type of path) {
    if (!current) return null
    found = null
    for (const b of boxes(bytes, current.body, current.end)) {
      if (b.type === type) { found = b; break }
    }
    current = found
  }
  return found
}

/** Every box of `type` directly under `parent`. */
export const children = (bytes: Uint8Array, parent: Pick<Box, 'body' | 'end'>, type: string): Box[] =>
  [...boxes(bytes, parent.body, parent.end)].filter(b => b.type === type)

const view = (bytes: Uint8Array): DataView => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

/** A version 0/1 full box's 32- or 64-bit field at `offset0` (version 0) or `offset1` (version 1) from the payload. */
function versioned (bytes: Uint8Array, box: Box, offset0: number, offset1: number): number {
  const v = bytes[box.body] ?? 0
  return v === 1 ? Number(view(bytes).getBigUint64(box.body + offset1)) : view(bytes).getUint32(box.body + offset0)
}

const trackId = (bytes: Uint8Array, tkhd: Box): number => view(bytes).getUint32(tkhd.body + ((bytes[tkhd.body] ?? 0) === 1 ? 20 : 12))
const mdhdTimescale = (bytes: Uint8Array, mdhd: Box): number => view(bytes).getUint32(mdhd.body + ((bytes[mdhd.body] ?? 0) === 1 ? 20 : 12))
const handler = (bytes: Uint8Array, hdlr: Box): string => text.decode(bytes.subarray(hdlr.body + 8, hdlr.body + 12))

/** What reading fragments needs from an init segment (ftyp + moov): the video track and each track's timescale. */
export interface InitInfo {
  videoTrack: number | null
  timescales: Map<number, number>
}

export function readInit (init: Uint8Array): InitInfo {
  const info: InitInfo = { videoTrack: null, timescales: new Map() }
  const moov = [...boxes(init)].find(b => b.type === 'moov')
  if (!moov) return info
  for (const trak of children(init, moov, 'trak')) {
    const tkhd = child(init, trak, 'tkhd')
    const mdhd = child(init, trak, 'mdia', 'mdhd')
    const hdlr = child(init, trak, 'mdia', 'hdlr')
    if (!tkhd || !mdhd) continue
    const id = trackId(init, tkhd)
    info.timescales.set(id, mdhdTimescale(init, mdhd))
    if (hdlr && handler(init, hdlr) === 'vide' && info.videoTrack === null) info.videoTrack = id
  }
  return info
}

/** The first sample's composition offset in a trun (0 when the run has none), in track units. */
function firstOffset (bytes: Uint8Array, trun: Box): number {
  const v = view(bytes)
  const flags = v.getUint32(trun.body) & 0xffffff
  if (!(flags & 0x800) || v.getUint32(trun.body + 4) === 0) return 0
  let at = trun.body + 8 + (flags & 0x1 ? 4 : 0) + (flags & 0x4 ? 4 : 0)
  at += (flags & 0x100 ? 4 : 0) + (flags & 0x200 ? 4 : 0) + (flags & 0x400 ? 4 : 0)
  return bytes[trun.body] === 1 ? v.getInt32(at) : v.getUint32(at)
}

/**
 * When a fragment's first video sample is shown, in seconds: its decode time (the moof's tfdt) plus its composition
 * offset, which B-frames make positive. A fragment starts on a keyframe, so this is the keyframe's presentation
 * time. Null without a video track.
 */
export function fragmentStart (moof: Uint8Array, init: InitInfo): number | null {
  const root = [...boxes(moof)].find(b => b.type === 'moof')
  if (!root || init.videoTrack === null) return null
  for (const traf of children(moof, root, 'traf')) {
    const tfhd = child(moof, traf, 'tfhd')
    const tfdt = child(moof, traf, 'tfdt')
    if (!tfhd || !tfdt || view(moof).getUint32(tfhd.body + 4) !== init.videoTrack) continue
    const scale = init.timescales.get(init.videoTrack)
    const trun = child(moof, traf, 'trun')
    return scale ? (versioned(moof, tfdt, 4, 4) + (trun ? firstOffset(moof, trun) : 0)) / scale : null
  }
  return null
}

export interface FragmentHandler {
  /** The init segment (ftyp and moov). */
  init: (data: Buffer) => void
  /** A fragment begins; the previous one, if any, is complete. */
  begin: (moof: Buffer) => void
  /** Bytes of the current fragment after its moof (its mdat). */
  data: (chunk: Buffer) => void
}

/** Boxes buffered whole; anything else (mdat) streams through `data`. */
const WHOLE = new Set(['ftyp', 'moov', 'moof'])
const MAX_WHOLE = 64 * 1024 ** 2

/**
 * Splits a fragmented MP4 byte stream (ffmpeg's `-movflags frag_keyframe+empty_moov` on a pipe) into its init
 * segment and fragments, without holding an mdat in memory. `end()` says whether the stream stopped on a box boundary.
 */
export function fragmentSplitter (handler: FragmentHandler): { push: (chunk: Buffer) => void, end: () => boolean } {
  let pending: Buffer = Buffer.alloc(0) // a header, or a whole box being collected
  let streaming = 0 // bytes of the current streamed box still to come
  let collecting: { type: string, size: number } | null = null
  let init: Buffer[] = []
  let inFragment = false

  function whole (type: string, box: Buffer): void {
    if (type === 'moof') {
      if (init.length) { handler.init(Buffer.concat(init)); init = [] }
      inFragment = true
      handler.begin(box)
    } else if (!inFragment) {
      init.push(box)
    }
  }

  function push (chunk: Buffer): void {
    let data = chunk
    while (data.length) {
      if (streaming) {
        const part = data.subarray(0, streaming)
        streaming -= part.length
        if (inFragment) handler.data(part)
        data = data.subarray(part.length)
        continue
      }
      pending = pending.length ? Buffer.concat([pending, data]) : data
      data = Buffer.alloc(0)
      if (!collecting) {
        const h = boxHeader(pending, 0)
        if (!h) return
        if (h.size < h.header) throw new Error(`Malformed MP4 box ${h.type}`)
        if (!WHOLE.has(h.type)) {
          const header = pending.subarray(0, h.header)
          if (inFragment) handler.data(header)
          streaming = h.size - h.header
          data = pending.subarray(h.header)
          pending = Buffer.alloc(0)
          continue
        }
        if (h.size > MAX_WHOLE) throw new Error(`MP4 ${h.type} box too large`)
        collecting = { type: h.type, size: h.size }
      }
      if (pending.length < collecting.size) return
      const box = pending.subarray(0, collecting.size)
      data = pending.subarray(collecting.size)
      pending = Buffer.alloc(0)
      const { type } = collecting
      collecting = null
      whole(type, Buffer.from(box))
    }
  }

  return { push, end: () => !streaming && !collecting && !pending.length }
}

/** The video track's keyframe presentation times in seconds, from an MP4 moov box; null when it has no usable sample tables. */
export function mp4Keyframes (moovBytes: Uint8Array): number[] | null {
  const moov = [...boxes(moovBytes)].find(b => b.type === 'moov')
  if (!moov) return null
  const mvhd = child(moovBytes, moov, 'mvhd')
  const movieScale = mvhd ? view(moovBytes).getUint32(mvhd.body + ((moovBytes[mvhd.body] ?? 0) === 1 ? 20 : 12)) : 0
  for (const trak of children(moovBytes, moov, 'trak')) {
    const hdlr = child(moovBytes, trak, 'mdia', 'hdlr')
    if (!hdlr || handler(moovBytes, hdlr) !== 'vide') continue
    const mdhd = child(moovBytes, trak, 'mdia', 'mdhd')
    const stbl = child(moovBytes, trak, 'mdia', 'minf', 'stbl')
    const stts = stbl && child(moovBytes, stbl, 'stts')
    const stss = stbl && child(moovBytes, stbl, 'stss')
    if (!mdhd || !stts || !stss) return null // without stss every sample is a keyframe: not a codec worth segmenting
    const scale = mdhdTimescale(moovBytes, mdhd)
    if (!scale) return null
    const v = view(moovBytes)
    // Sync samples, 1-based and ascending
    const syncCount = v.getUint32(stss.body + 4)
    const sync: number[] = []
    for (let i = 0; i < syncCount; i++) sync.push(v.getUint32(stss.body + 8 + i * 4) - 1)
    if (!sync.length) return null
    // Decode times from stts runs, composition offsets from ctts runs
    const runs = (box: Box, signed: boolean): Array<[count: number, value: number]> => {
      const n = v.getUint32(box.body + 4)
      return Array.from({ length: n }, (_, i): [number, number] =>
        [v.getUint32(box.body + 8 + i * 8), signed ? v.getInt32(box.body + 12 + i * 8) : v.getUint32(box.body + 12 + i * 8)])
    }
    const ctts = child(moovBytes, stbl, 'ctts')
    const valueAt = (list: Array<[number, number]>): (sample: number) => number => {
      let run = 0
      let first = 0 // first sample of `run`
      return sample => {
        while (run < list.length && sample >= first + list[run]![0]) { first += list[run]![0]; run++ }
        return list[run]?.[1] ?? 0
      }
    }
    const durations = runs(stts, false)
    const offsetOf = ctts ? valueAt(runs(ctts, true)) : () => 0
    // The edit list shifts presentation: an empty first edit delays it, a media time skips into it
    let shift = 0
    const elst = child(moovBytes, trak, 'edts', 'elst')
    if (elst) {
      const version = moovBytes[elst.body] ?? 0
      const entries = v.getUint32(elst.body + 4)
      let at = elst.body + 8
      for (let i = 0; i < entries; i++) {
        const segment = version === 1 ? Number(v.getBigUint64(at)) : v.getUint32(at)
        const media = version === 1 ? Number(v.getBigInt64(at + 8)) : v.getInt32(at + 4)
        at += version === 1 ? 20 : 12
        if (media === -1) { if (movieScale) shift += segment / movieScale * scale; continue }
        shift -= media
        break
      }
    }
    const times: number[] = []
    let sample = 0
    let dts = 0
    let next = 0 // index into sync
    for (const [count, delta] of durations) {
      for (let i = 0; i < count && next < sync.length; i++, sample++) {
        if (sample === sync[next]) {
          times.push((dts + offsetOf(sample) + shift) / scale)
          next++
        }
        dts += delta
      }
      if (next >= sync.length) break
    }
    return times.length ? times : null
  }
  return null
}
