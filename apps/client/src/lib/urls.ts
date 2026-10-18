// Every URL the pages link to, in one place.

type Id = string | number
type Optional = string | null | undefined

/** A film or show from Explore. */
export interface TitleRef {
  type: string
  source: string
  id: string
  title: string
  year?: Id | null | undefined
}

const enc = encodeURIComponent
export const baseName = (name: string): string => name.split('/').pop() ?? name

/** URLSearchParams from the entries that have a value; empty strings and nullish values are left out. */
const params = (entries: Record<string, Id | null | undefined>): URLSearchParams =>
  new URLSearchParams(Object.entries(entries).flatMap(([k, v]) => v != null && v !== '' ? [[k, String(v)]] : []))

export const urls = {
  search: (q: string, cat?: Optional): string => `/?${new URLSearchParams({ q, ...(cat && { cat }) })}`,
  /** The torrent page. `title` shows while loading; `link` is a private download-link id; `magnet` retains discovery hints. */
  torrent: (infoHash: Optional, { title, link, magnet }: { title?: Optional, link?: Optional, magnet?: Optional } = {}): string => {
    const q = params({ title, link, magnet })
    return `/t${infoHash ? `/${infoHash}` : ''}${q.size ? `?${q}` : ''}`
  },
  player: (ih: string, idx: Id): string => `/play/${ih}/${idx}`,
  raw: (ih: string, idx: Id, name: string): string => `/raw/${ih}/${idx}/${enc(baseName(name))}`,
  download: (ih: string, idx: Id, name: string): string => `/raw/${ih}/${idx}/${enc(baseName(name))}?download=1`,
  tar: (ih: string, name: string): string => `/tar/${ih}/${enc(name)}.tar`,
  m3u: (ih: string, idx?: Id | null): string => `/playlist.m3u?ih=${ih}${idx == null ? '' : `&idx=${idx}`}`,
  magnet: (ih: string, name: string): string => `magnet:?xt=urn:btih:${ih}&dn=${enc(name)}`,
  /** Explore with filters: { type, genre, year, res, sort }; empty ones are left out. */
  explore: (filters: Record<string, Id | null | undefined> = {}): string => {
    const q = params(filters)
    return `/explore${q.size ? `?${q}` : ''}`
  },
  /** A film or show from Explore. The name and year let the page find its releases. */
  title: (t: TitleRef): string => `/title/${t.type}/${t.source}/${enc(t.id)}?${new URLSearchParams({ title: t.title, ...(t.year ? { year: String(t.year) } : {}) })}`,
}

/** A menu entry: [label, href, title?]. */
export type PlayerApp = [label: string, href: string, title?: string]

/** External players for this device, as [label, href, title?], ready for a menu. They all open the same stream URL. */
export function playerApps (ih: string, idx: Id, name: string): PlayerApp[] {
  const stream = streamUrl(ih, idx, name)
  const ua = navigator.userAgent
  const ios = /iPhone|iPad/.test(ua) || (ua.includes('Mac') && navigator.maxTouchPoints > 1)
  const mac = ua.includes('Mac') && !ios
  const android = ua.includes('Android')
  const apps: Array<PlayerApp | false> = [
    mac && ['Open in IINA', `iina://weblink?url=${enc(stream)}`],
    (mac || ios) && ['Open in Infuse', `infuse://x-callback-url/play?url=${enc(stream)}`],
    (ios || android) && ['Open in VLC', `vlc://${stream}`],
    android && ['Open with another app', `intent://${stream.replace(/^https?:\/\//, '')}#Intent;scheme=${location.protocol.slice(0, -1)};type=video/*;end`],
    ['Playlist for any player (.m3u)', urls.m3u(ih, idx), 'Download a playlist your default video player opens'],
  ]
  return apps.filter(app => app !== false)
}

/** The stream URL with this page's address, for "Copy link". */
export function streamUrl (ih: string, idx: Id, name: string): string {
  return location.origin + urls.raw(ih, idx, name)
}
