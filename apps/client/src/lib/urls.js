// Every URL the pages link to, in one place.

const enc = encodeURIComponent
export const baseName = name => name.split('/').pop()

export const urls = {
  search: (q, cat) => `/?${new URLSearchParams({ q, ...(cat && { cat }) })}`,
  /** The torrent page. `title` shows while the file list loads; `link` is a search result's download-link id. */
  torrent: (infoHash, { title, link } = {}) =>
    `/t${infoHash ? `/${infoHash}` : ''}${title || link ? `?${new URLSearchParams({ ...(link && { link }), ...(title && { title }) })}` : ''}`,
  player: (ih, idx) => `/play/${ih}/${idx}`,
  raw: (ih, idx, name) => `/raw/${ih}/${idx}/${enc(baseName(name))}`,
  download: (ih, idx, name) => `/raw/${ih}/${idx}/${enc(baseName(name))}?download=1`,
  tar: (ih, name) => `/tar/${ih}/${enc(name)}.tar`,
  m3u: (ih, idx) => `/playlist.m3u?ih=${ih}${idx == null ? '' : `&idx=${idx}`}`,
  magnet: (ih, name) => `magnet:?xt=urn:btih:${ih}&dn=${enc(name)}`,
  /** Explore with filters: { type, genre, year, res, sort }; empty ones are left out. */
  explore: (filters = {}) => {
    const q = new URLSearchParams(Object.entries(filters).filter(([, v]) => v != null && v !== ''))
    return `/explore${q.size ? `?${q}` : ''}`
  },
  /** A film or show from Explore. The name and year let the page find its releases. */
  title: t => `/title/${t.type}/${t.source}/${enc(t.id)}?${new URLSearchParams({ title: t.title, ...(t.year && { year: t.year }) })}`,
}

/** External players for this device, as [label, href, title?], ready for a menu. They all open the same stream URL. */
export function playerApps (ih, idx, name) {
  const stream = location.origin + urls.raw(ih, idx, name)
  const ua = navigator.userAgent
  const ios = /iPhone|iPad/.test(ua) || (ua.includes('Mac') && navigator.maxTouchPoints > 1)
  const mac = ua.includes('Mac') && !ios
  const android = ua.includes('Android')
  return [
    mac && ['Open in IINA', `iina://weblink?url=${enc(stream)}`],
    (mac || ios) && ['Open in Infuse', `infuse://x-callback-url/play?url=${enc(stream)}`],
    (ios || android) && ['Open in VLC', `vlc://${stream}`],
    android && ['Open with another app', `intent://${stream.replace(/^https?:\/\//, '')}#Intent;scheme=${location.protocol.slice(0, -1)};type=video/*;end`],
    ['Playlist for any player (.m3u)', urls.m3u(ih, idx), 'Download a playlist your default video player opens'],
  ].filter(Boolean)
}

/** The stream URL with this page's address, for "Copy link". */
export const streamUrl = (ih, idx, name) => location.origin + urls.raw(ih, idx, name)
