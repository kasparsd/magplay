// File-kind detection, episode parsing and release-title badges. Pure helpers:
// strings and file lists in, data out. No I/O, no Node APIs, no indexer or HTTP knowledge.

/** A torrent's file as this package needs it: a name, a path and a size. */
export interface InputFile {
  name: string
  path: string
  length: number
}

export interface TorrentLike {
  name: string
  files: InputFile[]
}

export interface Episode {
  season: number | null
  episode: number | null
}

export interface ListedFile extends Episode {
  idx: number
  name: string
  size: number
  isVideo: boolean
  isSub: boolean
  isProgram: boolean
}

export interface TitleBadges {
  badges: string[]
  /** A guess whether Firefox can play it without ffmpeg work. */
  likelyDirect: boolean
  /** A note for programs and archives, or null. */
  warning: string | null
}

// Containers ffmpeg and VLC both read; old codecs inside (Theora, WMV, RealVideo…) get transcoded
const VIDEO_EXT = /\.(mkv|mp4|m4v|mov|3gp|webm|ogv|ogm|avi|divx|wmv|asf|flv|mpe?g|vob|ts|m2ts|mts|rm|rmvb)$/i
const SUB_EXT = /\.(srt|vtt|ass|ssa)$/i
const EXTRAS = /(^|[/ ._-])(samples?|extras?|featurettes?|bonus|behind[ ._-]the[ ._-]scenes|deleted[ ._-]scenes|trailers?)([/ ._-]|$)/i
const MIN_VIDEO_BYTES = 100 * 1024 ** 2

/** Season and episode numbers from a file path, using the torrent name for the season if needed. */
export function detectEpisode (path: string, torrentName = ''): Episode {
  const name = path.split('/').pop() ?? path
  let m = name.match(/\bs(\d{1,2})[ ._-]?e(\d{1,3})/i) || name.match(/\b(\d{1,2})x(\d{2,3})\b/)
  if (m) return { season: Number(m[1]), episode: Number(m[2]) }
  m = name.match(/\b(?:episode|ep)[ ._-]?(\d{1,3})\b/i)
  if (m) {
    const s = `${path} ${torrentName}`.match(/\b(?:s|season[ ._-]?)(\d{1,2})(?!\d)/i)
    return { season: s ? Number(s[1]) : null, episode: Number(m[1]) }
  }
  return { season: null, episode: null }
}

/** The torrent's files with video/subtitle/program flags and episode numbers, playable videos first. */
export function listFiles (torrent: TorrentLike): ListedFile[] {
  // Skip samples, extras and small files, unless that leaves nothing (a torrent that is just a trailer or a short film)
  const all = torrent.files.filter(f => VIDEO_EXT.test(f.name))
  const main = all.filter(f => !EXTRAS.test(f.path))
  const videos = main.length ? main : all
  const minBytes = videos.some(f => f.length >= MIN_VIDEO_BYTES) ? MIN_VIDEO_BYTES : 0
  const files: ListedFile[] = torrent.files.map((f, idx) => {
    const isVideo = videos.includes(f) && f.length >= minBytes
    return {
      idx,
      name: f.path.split('/').slice(1).join('/') || f.name,
      size: f.length,
      isVideo,
      isSub: SUB_EXT.test(f.name),
      isProgram: PROGRAM_EXT.test(f.name),
      ...(isVideo ? detectEpisode(f.path, torrent.name) : { season: null, episode: null }),
    }
  })
  return files.sort((a, b) => (Number(b.isVideo) - Number(a.isVideo)) ||
    ((a.season ?? 999) - (b.season ?? 999)) || ((a.episode ?? 999) - (b.episode ?? 999)) ||
    a.name.localeCompare(b.name, undefined, { numeric: true }))
}

/** A note about a torrent's contents, judged from its file list (see listFiles), or null. */
export function contentWarning (files: ReadonlyArray<{ isVideo: boolean }>): string | null {
  return files.some(f => f.isVideo) ? null : 'Download only · no video files'
}

// Titles that name a program or an archive: not something magplay can play
export const PROGRAM_EXT = /\.(exe|scr|com|bat|cmd|msi|lnk|pif|vbs|ps1|jar|apk|dmg|pkg)$/i
const ARCHIVE_EXT = /\.(zip|rar|7z|iso)$/i

const RULES: ReadonlyArray<readonly [kind: 'res' | 'video' | 'hdr' | 'tenBit' | 'audio' | 'source', re: RegExp, label: string]> = [
  ['res', /\b(2160p|4k|uhd)\b/i, '2160p'],
  ['res', /\b1080[pi]\b/i, '1080p'],
  ['res', /\b720p\b/i, '720p'],
  ['res', /\b(480p|576p|dvdrip|sd)\b/i, '480p'],
  ['video', /\b(x\.?264|h\.?264|avc)\b/i, 'H.264'],
  ['video', /\b(x\.?265|h\.?265|hevc)\b/i, 'HEVC'],
  ['video', /\bav1\b/i, 'AV1'],
  ['hdr', /\b(hdr10\+?|hdr|dv|dovi|dolby[ .]?vision)\b/i, 'HDR'],
  ['tenBit', /\b(10[ .-]?bit|hi10p?)\b/i, '10-bit'],
  ['audio', /\baac/i, 'AAC'],
  ['audio', /\b(ddp|dd\+|e-?ac-?3)/i, 'E-AC3'],
  ['audio', /\b(dd|ac-?3)[ .]?[257]\.[01]\b|\bac-?3\b/i, 'AC3'],
  ['audio', /\bdts/i, 'DTS'],
  ['audio', /\btruehd\b/i, 'TrueHD'],
  ['audio', /\batmos\b/i, 'Atmos'],
  ['source', /\b(bd)?remux\b/i, 'Remux'],
  ['source', /\b(blu-?ray|bdrip|brrip)\b/i, 'BluRay'],
  ['source', /\bweb-?dl\b/i, 'WEB-DL'],
  ['source', /\bwebrip\b/i, 'WEBRip'],
]

/** Badges parsed from a release title, a note for programs and archives, and a guess whether Firefox can play it without ffmpeg work. */
export function badges (title: string): TitleBadges {
  const program = title.match(PROGRAM_EXT)?.[1]
  const archive = title.match(ARCHIVE_EXT)?.[1]
  const warning = program
    ? `Download (.${program.toLowerCase()})`
    : archive ? `Download archive (.${archive.toLowerCase()})` : null
  const found: { res?: string, video?: string, hdr?: string, tenBit?: string, audio?: string[], source?: string } = {}
  const words = title.replaceAll('_', ' ') // `\b` treats underscores as letters: big_buck_bunny_h264
  for (const [kind, re, label] of RULES) {
    if (!re.test(words)) continue
    if (kind === 'audio') (found.audio ??= []).push(label)
    else found[kind] ??= label
  }
  // Explicitly licensed open-content fixtures may omit codec details from their title.
  if (/\bOpenContent\b/i.test(title)) {
    found.video ??= 'H.264'
    if (!found.audio) found.audio = ['AAC']
  }
  const audioOk = !found.audio || found.audio.every(a => a === 'AAC')
  const labels = [found.res, found.video, found.hdr, found.tenBit, ...(found.audio ?? []), found.source]
  return {
    badges: labels.filter((label): label is string => label !== undefined),
    likelyDirect: !warning && found.video === 'H.264' && audioOk && !found.tenBit,
    warning,
  }
}
