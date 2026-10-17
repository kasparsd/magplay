import { PROGRAM_EXT } from './sources/release.js'

// Containers ffmpeg and VLC both read; old codecs inside (Theora, WMV, RealVideo…) get transcoded
const VIDEO_EXT = /\.(mkv|mp4|m4v|mov|3gp|webm|ogv|ogm|avi|divx|wmv|asf|flv|mpe?g|vob|ts|m2ts|mts|rm|rmvb)$/i
const SUB_EXT = /\.(srt|vtt|ass|ssa)$/i
const EXTRAS = /(^|[/ ._-])(samples?|extras?|featurettes?|bonus|behind[ ._-]the[ ._-]scenes|deleted[ ._-]scenes|trailers?)([/ ._-]|$)/i
const MIN_VIDEO_BYTES = 100 * 1024 ** 2

/** Season and episode numbers from a file path, using the torrent name for the season if needed. */
export function detectEpisode (path, torrentName = '') {
  const name = path.split('/').pop()
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
export function listFiles (torrent) {
  // Skip samples, extras and small files, unless that leaves nothing (a torrent that is just a trailer or a short film)
  const all = torrent.files.filter(f => VIDEO_EXT.test(f.name))
  const main = all.filter(f => !EXTRAS.test(f.path))
  const videos = main.length ? main : all
  const minBytes = videos.some(f => f.length >= MIN_VIDEO_BYTES) ? MIN_VIDEO_BYTES : 0
  const files = torrent.files.map((f, idx) => {
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
  return files.sort((a, b) => (b.isVideo - a.isVideo) ||
    ((a.season ?? 999) - (b.season ?? 999)) || ((a.episode ?? 999) - (b.episode ?? 999)) ||
    a.name.localeCompare(b.name, undefined, { numeric: true }))
}

/** A note about a torrent's contents, judged from its file list (see listFiles), or null. */
export function contentWarning (files) {
  return files.some(f => f.isVideo) ? null : 'No media file found'
}
