// The common shape every source adapter returns, so search, dedupe and the UI don't care where a result came from.

const toNum = v => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v))

/**
 * @typedef {object} Release
 * @property {string} title
 * @property {string|null} infoHash  40-char lowercase hex
 * @property {string|null} magnet
 * @property {string|null} link      http(s) download link (a .torrent, or a redirect to a magnet); only when there's no magnet
 * @property {number|null} size
 * @property {number|null} seeders
 * @property {string[]} sources      where it was found, e.g. ["Prowlarr/ExampleIndexer"]
 * @property {string[]} badges
 * @property {boolean} likelyDirect
 */

/** Normalizes raw fields from an indexer into a Release, or null if it can't be played. */
export function release ({ title, infoHash, magnet, link, size, seeders }, source) {
  title = String(title ?? '').trim()
  if (!title) return null
  magnet = typeof magnet === 'string' && magnet.startsWith('magnet:') ? magnet : null
  infoHash = String(infoHash || magnet?.match(/btih:([a-f0-9]{40})/i)?.[1] || '').toLowerCase()
  if (!/^[a-f0-9]{40}$/.test(infoHash)) infoHash = null
  if (!magnet && infoHash) magnet = `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(title)}`
  link = !magnet && typeof link === 'string' && /^https?:\/\//.test(link) ? link : null
  if (!magnet && !link) return null
  return { title, infoHash, magnet, link, size: toNum(size), seeders: toNum(seeders), sources: [source], ...badges(title) }
}

const RULES = [
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

// Titles that name a program or an archive: not something magplay can play
export const PROGRAM_EXT = /\.(exe|scr|com|bat|cmd|msi|lnk|pif|vbs|ps1|jar|apk|dmg|pkg)$/i
const ARCHIVE_EXT = /\.(zip|rar|7z|iso)$/i

/** Badges parsed from a release title, a note for programs and archives, and a guess whether Firefox can play it without ffmpeg work. */
export function badges (title) {
  const program = title.match(PROGRAM_EXT)?.[1]
  const archive = title.match(ARCHIVE_EXT)?.[1]
  const warning = program ? `Not a media file (.${program.toLowerCase()})`
    : archive ? `Archive (.${archive.toLowerCase()}), can't stream` : null
  const found = {}
  for (const [kind, re, label] of RULES) {
    if (!re.test(title)) continue
    if (kind === 'audio') (found.audio ??= []).push(label)
    else found[kind] ??= label
  }
  // Explicitly licensed open-content fixtures may omit codec details from their title.
  if (/\bOpenContent\b/i.test(title)) {
    found.video ??= 'H.264'
    if (!found.audio) found.audio = ['AAC']
  }
  const audioOk = !found.audio || found.audio.every(a => a === 'AAC')
  return {
    badges: [found.res, found.video, found.hdr, found.tenBit, ...(found.audio ?? []), found.source].filter(Boolean),
    likelyDirect: !warning && found.video === 'H.264' && audioOk && !found.tenBit,
    warning,
  }
}

/** Error for a source that answered but failed; `message` is shown to the user next to the source name. */
export class SourceError extends Error {}

export const statusError = status =>
  new SourceError(status === 401 || status === 403 ? `HTTP ${status}: check the API key` : `HTTP ${status}`)

/** fetch() with errors turned into short, readable SourceErrors. `acceptErrors` returns non-2xx responses for the caller to read. */
export async function request (fetchImpl, url, opts, { acceptErrors = false } = {}) {
  let res
  try {
    res = await fetchImpl(url, opts)
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') throw err
    throw new SourceError(`can't reach ${new URL(url).host} (${err.cause?.code || err.message})`)
  }
  if (!res.ok && !acceptErrors) throw statusError(res.status)
  return res
}
