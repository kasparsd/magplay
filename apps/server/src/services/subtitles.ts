// Subtitle files for direct play: an embedded track (reading the whole file) or an external subtitle file, as WebVTT.
import type { MediaTools } from '@magplay/playback'
import type { TorrentEngine } from '@magplay/torrent-engine'
import { HttpError } from '../http/errors.ts'

export interface SubtitleOptions {
  engine: TorrentEngine
  media: MediaTools
  input: (ih: string, idx: number) => string
}

/** Converted tracks are kept for the life of the server; a failed conversion is forgotten so it can be retried. */
export function createSubtitles ({ engine, media, input }: SubtitleOptions): { vtt: (ih: string, idx: number, track: string) => Promise<string> } {
  const cache = new Map<string, Promise<string>>()
  return {
    vtt (ih, idx, name) {
      // Embedded track N, or "file" for an external subtitle file
      const track = name.replace(/\.vtt$/, '')
      if (!/^(\d+|file)$/.test(track)) return Promise.reject(new HttpError(404, 'Not found'))
      const key = `${ih}/${idx}/${track}`
      let job = cache.get(key)
      if (!job) {
        job = (async () => {
          await engine.file(ih, idx)
          return media.subtitleToVtt(input(ih, idx), track === 'file' ? null : Number(track))
        })()
        job.catch(() => cache.delete(key))
        cache.set(key, job)
      }
      return job
    },
  }
}
