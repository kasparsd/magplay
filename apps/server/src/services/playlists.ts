// An .m3u for external players: one file, or every video in the torrent (a season) when idx is omitted.
import type { TorrentEngine } from '@magplay/torrent-engine'
import { HttpError } from '../http/errors.ts'

export interface Playlist {
  filename: string
  body: string
}

const base = (name: string): string => name.split('/').pop() ?? name

/** `origin` must be the address the browser reached us on, never 127.0.0.1. */
export async function playlist (engine: TorrentEngine, origin: string, ih: string | null, idx: string | null): Promise<Playlist> {
  if (!ih || !/^[a-f0-9]{40}$/.test(ih)) throw new HttpError(400, 'Bad info hash')
  const torrent = await engine.add(ih)
  const files = engine.describe(torrent).files.filter(f => idx === null ? f.isVideo : f.idx === Number(idx))
  const first = files[0]
  if (!first) throw new HttpError(404, 'No video files')
  const lines = ['#EXTM3U', ...files.flatMap(f => [`#EXTINF:-1,${base(f.name)}`, `${origin}/raw/${ih}/${f.idx}/${encodeURIComponent(base(f.name))}`])]
  const title = (idx === null ? torrent.name : base(first.name)).replace(/[^\w.-]+/g, '_')
  return { filename: `${title}.m3u`, body: lines.join('\n') + '\n' }
}
