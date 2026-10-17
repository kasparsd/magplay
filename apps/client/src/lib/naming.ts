// Human names for releases and tracks: the title from a release name, subtitle languages from
// file names, and picking a track by a remembered language. Pure string helpers.

// Where a release name stops being the title: a year, an episode or season, a resolution or a source tag
const TITLE_END = /[ ([](?:(?:19|20)\d{2}|s\d{1,2}(?:e\d{1,3})?|season|complete|\d{3,4}p|4k|uhd|bluray|blu-ray|brrip|bdrip|web-?dl|webrip|web|hdtv|dvdrip|x26[45]|h\.?26[45]|hevc|remux|proper|repack)\b/i
const VIDEO_EXT = /\.(?:mkv|mp4|m4v|mov|webm|avi|ts|m2ts|wmv|flv|mpe?g)$/i

/** "Fleabag.S01.1080p.BluRay.x264-GRP" → "Fleabag"; "Big_Buck_Bunny_(2008).mov" → "Big Buck Bunny". Falls back to the cleaned name. */
export function releaseName (name: string): string {
  const base = (name.split('/').pop() ?? name).replace(VIDEO_EXT, '')
  const spaced = base.replace(/^\[[^\]]*\]\s*/, '').replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim()
  const end = spaced.search(TITLE_END)
  const title = (end > 0 ? spaced.slice(0, end) : spaced).replace(/[\s([-]+$/, '').trim()
  return title || spaced
}

/** The language code in a subtitle file name such as "Movie.en.srt" or "Movie.eng.forced.srt", or null. */
export function languageFromName (name: string): string | null {
  const m = name.toLowerCase().match(/[._-]([a-z]{2,3})(?:[._-](?:forced|sdh|cc|hi))?\.(?:srt|vtt|ass|ssa)$/)
  return m?.[1] ?? null
}

/** "en" and "eng" are the same language; codes are compared without case. */
export function sameLanguage (a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false
  const [x, y] = [a.toLowerCase(), b.toLowerCase()]
  return x === y || (Math.min(x.length, y.length) === 2 && (x.startsWith(y) || y.startsWith(x)))
}

/** The first track in `language`, or undefined when there is no preference or no match. */
export function pickByLanguage<T extends { language: string | null }> (tracks: readonly T[], language: string | null | undefined): T | undefined {
  return language ? tracks.find(t => sameLanguage(t.language, language)) : undefined
}
