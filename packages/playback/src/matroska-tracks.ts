// Matroska's track list (the `Tracks` element), read directly: Mediabunny's demuxer only surfaces video and audio
// tracks, and embedded subtitles are what the player lists and ffmpeg extracts by subtitle-stream index.
import type { SubtitleTrack } from '@magplay/api-contract'

/** Bytes [start, end) of the input; returns fewer bytes at the end of the file. */
export type RangeReader = (start: number, end: number) => Promise<Uint8Array>

const ID = {
  EBML: 0x1A45DFA3,
  Segment: 0x18538067,
  SeekHead: 0x114D9B74,
  Seek: 0x4DBB,
  SeekID: 0x53AB,
  SeekPosition: 0x53AC,
  Tracks: 0x1654AE6B,
  TrackEntry: 0xAE,
  TrackType: 0x83,
  CodecID: 0x86,
  Name: 0x536E,
  Language: 0x22B59C,
  LanguageBCP47: 0x22B59D,
  Cluster: 0x1F43B675,
  Cues: 0x1C53BB6B,
} as const

const SUBTITLE_TYPE = 17
const HEAD = 256 * 1024
const TRACKS_LIMIT = 4 * 1024 * 1024

/** Matroska CodecIDs as the codec names the player and ffmpeg's subtitle mapping know. */
const SUBTITLE_CODECS: Readonly<Record<string, string>> = {
  'S_TEXT/UTF8': 'subrip',
  'S_TEXT/ASCII': 'text',
  'S_TEXT/ASS': 'ass',
  'S_TEXT/SSA': 'ssa',
  'S_TEXT/WEBVTT': 'webvtt',
  'S_TEXT/USF': 'usf',
  'S_HDMV/PGS': 'hdmv_pgs_subtitle',
  'S_HDMV/TEXTST': 'hdmv_text_subtitle',
  S_VOBSUB: 'dvd_subtitle',
  S_DVBSUB: 'dvb_subtitle',
  S_KATE: 'kate',
}
export const TEXT_SUBTITLE_CODECS = new Set(['subrip', 'srt', 'ass', 'ssa', 'webvtt', 'mov_text', 'text'])

interface Element { id: number, size: number | null, dataStart: number, end: number }

/** Reads the element header at `pos`; null when the buffer ends first. `size` is null for an unknown-size element. */
function readElement (buf: Uint8Array, pos: number): Element | null {
  if (pos >= buf.length) return null
  const idLength = Math.clz32(buf[pos]!) - 23
  if (idLength < 1 || idLength > 4 || pos + idLength > buf.length) return null
  let id = 0
  for (let i = 0; i < idLength; i++) id = id * 256 + buf[pos + i]!
  const sizePos = pos + idLength
  if (sizePos >= buf.length) return null
  const sizeLength = Math.clz32(buf[sizePos]!) - 23
  if (sizeLength < 1 || sizeLength > 8 || sizePos + sizeLength > buf.length) return null
  let size = buf[sizePos]! & (0xFF >> sizeLength)
  let allOnes = size === (0xFF >> sizeLength)
  for (let i = 1; i < sizeLength; i++) {
    const b = buf[sizePos + i]!
    size = size * 256 + b
    if (b !== 0xFF) allOnes = false
  }
  const dataStart = sizePos + sizeLength
  return { id, size: allOnes ? null : size, dataStart, end: allOnes ? buf.length : dataStart + size }
}

const uint = (buf: Uint8Array, el: Element): number => {
  let n = 0
  for (let i = el.dataStart; i < Math.min(el.end, buf.length); i++) n = n * 256 + buf[i]!
  return n
}
const text = (buf: Uint8Array, el: Element): string => new TextDecoder().decode(buf.subarray(el.dataStart, el.end)).replace(/\0+$/, '')

function parseTracks (buf: Uint8Array, tracks: Element): SubtitleTrack[] {
  const found: SubtitleTrack[] = []
  for (let pos = tracks.dataStart; pos < tracks.end;) {
    const entry = readElement(buf, pos)
    if (!entry || entry.size === null || entry.end > buf.length) break
    if (entry.id === ID.TrackEntry) {
      let type = 0
      let codecId = ''
      let name: string | null = null
      let language: string | null = null
      let bcp47: string | null = null
      for (let p = entry.dataStart; p < entry.end;) {
        const child = readElement(buf, p)
        if (!child || child.size === null || child.end > buf.length) break
        if (child.id === ID.TrackType) type = uint(buf, child)
        else if (child.id === ID.CodecID) codecId = text(buf, child)
        else if (child.id === ID.Name) name = text(buf, child)
        else if (child.id === ID.Language) language = text(buf, child)
        else if (child.id === ID.LanguageBCP47) bcp47 = text(buf, child)
        p = child.end
      }
      if (type === SUBTITLE_TYPE) {
        const codec = SUBTITLE_CODECS[codecId] ?? codecId.replace(/^S_/, '').toLowerCase()
        const lang = bcp47 ?? language ?? 'eng' // the Matroska default language is English
        found.push({ index: found.length, codec, language: lang === 'und' ? null : lang, title: name, text: TEXT_SUBTITLE_CODECS.has(codec) })
      }
    }
    pos = entry.end
  }
  return found
}

/**
 * The subtitle tracks of a Matroska/WebM file, in stream order (ffmpeg's `0:s:N`). Reads the file's head, and follows
 * the SeekHead to a Tracks element stored elsewhere. An empty list for files whose Tracks can't be found.
 */
export async function matroskaSubtitles (read: RangeReader): Promise<SubtitleTrack[]> {
  const head = await read(0, HEAD)
  const ebml = readElement(head, 0)
  if (!ebml || ebml.id !== ID.EBML || ebml.size === null) return []
  const segment = readElement(head, ebml.end)
  if (!segment || segment.id !== ID.Segment) return []
  let tracksPosition: number | null = null
  for (let pos = segment.dataStart; pos < head.length;) {
    const el = readElement(head, pos)
    if (!el || el.size === null) break
    if (el.id === ID.Tracks) {
      if (el.end <= head.length) return parseTracks(head, el)
      tracksPosition = pos
      break
    }
    if (el.id === ID.Cluster || el.id === ID.Cues) break
    if (el.id === ID.SeekHead && el.end <= head.length) {
      for (let p = el.dataStart; p < el.end;) {
        const seek = readElement(head, p)
        if (!seek || seek.size === null) break
        if (seek.id === ID.Seek) {
          let target = 0
          let position = -1
          for (let q = seek.dataStart; q < seek.end;) {
            const field = readElement(head, q)
            if (!field || field.size === null) break
            if (field.id === ID.SeekID) target = uint(head, field)
            if (field.id === ID.SeekPosition) position = uint(head, field)
            q = field.end
          }
          if (target === ID.Tracks && position >= 0) tracksPosition = segment.dataStart + position
        }
        p = seek.end
      }
    }
    pos = el.end
  }
  if (tracksPosition === null) return []
  const header = await read(tracksPosition, tracksPosition + 16)
  const tracks = readElement(header, 0)
  if (!tracks || tracks.id !== ID.Tracks || tracks.size === null || tracks.size > TRACKS_LIMIT) return []
  const buf = await read(tracksPosition, tracksPosition + tracks.end)
  const el = readElement(buf, 0)
  return el ? parseTracks(buf, el) : []
}
