// A file's keyframe times from its own index, read with a few range requests: Matroska Cues or the MP4 video
// track's sample tables. HLS segments for copied video must start on keyframes, and the same boundaries must come
// out of every ffmpeg run, so they are planned from these times. Files without an index (MPEG-TS, AVI, fragmented
// MP4, an MKV without cues) get null.
import { boxHeader, mp4Keyframes } from './mp4.ts'

/** Bytes [start, end) of the file; may return fewer at the end of the file. */
export type ReadRange = (start: number, end: number) => Promise<Uint8Array>

const HEAD_BYTES = 256 * 1024
/** An index larger than this isn't read: tens of thousands of cue points fit in a few MB. */
const MAX_INDEX_BYTES = 64 * 1024 ** 2

/** Keyframe presentation times in seconds, ascending and unique, or null when the file has no usable index. */
export async function keyframeIndex (read: ReadRange, size: number): Promise<number[] | null> {
  const head = await read(0, Math.min(size, HEAD_BYTES))
  if (head.length >= 4 && head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return clean(await matroskaKeyframes(read, size, head))
  const first = boxHeader(head, 0)
  if (first && (first.type === 'ftyp' || first.type === 'moov')) return clean(await mp4Index(read, size, head))
  return null
}

function clean (times: number[] | null): number[] | null {
  if (!times?.length) return null
  const sorted = [...new Set(times.filter(Number.isFinite))].sort((a, b) => a - b)
  return sorted.length ? sorted : null
}

// ---- MP4 ----

/** Finds the moov box by walking top-level box headers (it may follow the mdat) and reads its sample tables. */
async function mp4Index (read: ReadRange, size: number, head: Uint8Array): Promise<number[] | null> {
  let at = 0
  for (let i = 0; i < 64 && at < size; i++) {
    const bytes = at + 16 <= head.length ? head.subarray(at, at + 16) : await read(at, Math.min(size, at + 16))
    const h = boxHeader(bytes, 0)
    if (!h || (h.size !== 0 && h.size < h.header)) return null
    const boxSize = h.size === 0 ? size - at : h.size
    if (h.type === 'moov') {
      if (boxSize > MAX_INDEX_BYTES) return null
      const moov = at + boxSize <= head.length ? head.subarray(at, at + boxSize) : await read(at, at + boxSize)
      return moov.length === boxSize ? mp4Keyframes(moov) : null
    }
    if (h.type === 'moof') return null // fragmented: no sample tables in moov
    at += boxSize
  }
  return null
}

// ---- Matroska ----

const ID = {
  Segment: 0x18538067,
  SeekHead: 0x114d9b74,
  Seek: 0x4dbb,
  SeekID: 0x53ab,
  SeekPosition: 0x53ac,
  Info: 0x1549a966,
  TimestampScale: 0x2ad7b1,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackNumber: 0xd7,
  TrackType: 0x83,
  Cues: 0x1c53bb6b,
  CuePoint: 0xbb,
  CueTime: 0xb3,
  CueTrackPositions: 0xb7,
  CueTrack: 0xf7,
  Cluster: 0x1f43b675,
} as const

interface Element {
  id: number
  /** Offset of the payload. */
  data: number
  /** Payload size; null when the size is unknown (live streams). */
  size: number | null
  /** Header length. */
  header: number
}

/** An EBML element header at `at`, or null when it doesn't fit. IDs keep their length marker; sizes don't. */
export function ebmlHeader (bytes: Uint8Array, at: number): Element | null {
  const first = bytes[at]
  if (first === undefined || first === 0) return null
  const idLength = Math.clz32(first) - 23
  if (idLength > 4 || at + idLength > bytes.length) return null
  let id = 0
  for (let i = 0; i < idLength; i++) id = id * 256 + (bytes[at + i] ?? 0)
  const sizeAt = at + idLength
  const lead = bytes[sizeAt]
  if (lead === undefined || lead === 0) return null
  const sizeLength = Math.clz32(lead) - 23
  if (sizeAt + sizeLength > bytes.length) return null
  let size = lead & (0xff >> sizeLength)
  let allOnes = size === (0xff >> sizeLength)
  for (let i = 1; i < sizeLength; i++) {
    const byte = bytes[sizeAt + i] ?? 0
    size = size * 256 + byte
    allOnes &&= byte === 0xff
  }
  return { id, data: sizeAt + sizeLength, size: allOnes ? null : size, header: idLength + sizeLength }
}

/** The elements directly inside `bytes[from, to)`. */
function * elements (bytes: Uint8Array, from: number, to: number): Generator<Element> {
  let at = from
  while (at < to) {
    const e = ebmlHeader(bytes, at)
    if (!e || e.size === null || e.data + e.size > to) return
    yield e
    at = e.data + e.size
  }
}

function uint (bytes: Uint8Array, e: Element): number {
  let n = 0
  for (let i = 0; i < (e.size ?? 0); i++) n = n * 256 + (bytes[e.data + i] ?? 0)
  return n
}

/** The whole element at absolute offset `at`, from `head` when it holds it, else read; null if it can't be read. */
async function elementAt (read: ReadRange, size: number, head: Uint8Array, at: number): Promise<{ bytes: Uint8Array, e: Element } | null> {
  const probe = at + 16 <= head.length ? head.subarray(at, at + 16) : await read(at, Math.min(size, at + 16))
  const h = ebmlHeader(probe, 0)
  if (!h || h.size === null || h.size > MAX_INDEX_BYTES) return null
  const end = at + h.data + h.size
  const bytes = end <= head.length ? head.subarray(at, end) : await read(at, end)
  return bytes.length === end - at ? { bytes, e: h } : null
}

async function matroskaKeyframes (read: ReadRange, size: number, head: Uint8Array): Promise<number[] | null> {
  const ebml = ebmlHeader(head, 0)
  if (!ebml || ebml.size === null) return null
  const segment = ebmlHeader(head, ebml.data + ebml.size)
  if (!segment || segment.id !== ID.Segment) return null
  const base = segment.data // SeekPosition is relative to the Segment's payload
  const positions = new Map<number, number>()
  let scale = 1_000_000
  let videoTrack: number | null = null
  let cuesAt: number | null = null

  const readSeekHead = (bytes: Uint8Array, e: Element): void => {
    for (const seek of elements(bytes, e.data, e.data + (e.size ?? 0))) {
      if (seek.id !== ID.Seek) continue
      let target = 0
      let position: number | null = null
      for (const field of elements(bytes, seek.data, seek.data + (seek.size ?? 0))) {
        if (field.id === ID.SeekID) target = uint(bytes, field)
        if (field.id === ID.SeekPosition) position = uint(bytes, field)
      }
      if (target && position !== null && !positions.has(target)) positions.set(target, base + position)
    }
  }
  const readInfo = (bytes: Uint8Array, e: Element): void => {
    for (const field of elements(bytes, e.data, e.data + (e.size ?? 0))) if (field.id === ID.TimestampScale) scale = uint(bytes, field) || scale
  }
  const readTracks = (bytes: Uint8Array, e: Element): void => {
    for (const entry of elements(bytes, e.data, e.data + (e.size ?? 0))) {
      if (entry.id !== ID.TrackEntry) continue
      let number = 0
      let type = 0
      for (const field of elements(bytes, entry.data, entry.data + (entry.size ?? 0))) {
        if (field.id === ID.TrackNumber) number = uint(bytes, field)
        if (field.id === ID.TrackType) type = uint(bytes, field)
      }
      if (type === 1 && videoTrack === null) videoTrack = number
    }
  }

  // Top-level elements in the head, up to the first cluster
  let haveInfo = false
  let haveTracks = false
  let at = segment.data
  while (at < head.length) {
    const e = ebmlHeader(head, at)
    if (!e || e.size === null || e.id === ID.Cluster) break
    if (e.data + e.size <= head.length) {
      if (e.id === ID.SeekHead) readSeekHead(head, e)
      if (e.id === ID.Info) { readInfo(head, e); haveInfo = true }
      if (e.id === ID.Tracks) { readTracks(head, e); haveTracks = true }
      if (e.id === ID.Cues) cuesAt = at
    }
    at = e.data + e.size
  }
  // A SeekHead may point at a second SeekHead (often at the end of the file)
  const more = positions.get(ID.SeekHead)
  if (more !== undefined && more >= head.length) {
    const found = await elementAt(read, size, head, more)
    if (found?.e.id === ID.SeekHead) readSeekHead(found.bytes, { ...found.e, data: found.e.data })
  }
  for (const [id, done, apply] of [[ID.Info, haveInfo, readInfo], [ID.Tracks, haveTracks, readTracks]] as const) {
    const position = positions.get(id)
    if (done || position === undefined) continue
    const found = await elementAt(read, size, head, position)
    if (found?.e.id === id) apply(found.bytes, found.e)
  }
  cuesAt ??= positions.get(ID.Cues) ?? null
  if (cuesAt === null) return null
  const cues = await elementAt(read, size, head, cuesAt)
  if (!cues || cues.e.id !== ID.Cues) return null

  const times: number[] = []
  for (const point of elements(cues.bytes, cues.e.data, cues.e.data + (cues.e.size ?? 0))) {
    if (point.id !== ID.CuePoint) continue
    let time: number | null = null
    let forVideo = videoTrack === null // without track info, every cue counts
    for (const field of elements(cues.bytes, point.data, point.data + (point.size ?? 0))) {
      if (field.id === ID.CueTime) time = uint(cues.bytes, field)
      if (field.id === ID.CueTrackPositions && videoTrack !== null) {
        for (const pos of elements(cues.bytes, field.data, field.data + (field.size ?? 0))) {
          if (pos.id === ID.CueTrack && uint(cues.bytes, pos) === videoTrack) forVideo = true
        }
      }
    }
    if (time !== null && forVideo) times.push(time * scale / 1e9)
  }
  return times
}
