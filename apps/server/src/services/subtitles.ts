// Subtitle files for direct play: an embedded track (reading the whole file) or an external subtitle file, as WebVTT.
// SubRip and WebVTT files convert here; embedded tracks and other formats (ASS) go through ffmpeg.
import { isTextSubtitleFile, subtitleFileToVtt, UnplayableError } from '@magplay/playback'
import type { MediaTools } from '@magplay/playback'
import type { TorrentEngine } from '@magplay/torrent-engine'
import { HttpError } from '../http/errors.ts'

/** Subtitle files are small; anything bigger is not a subtitle file. */
const FILE_LIMIT = 16 * 1024 ** 2

export interface SubtitleOptions {
  engine: TorrentEngine
  media: MediaTools
  input: (ih: string, idx: number) => string
  limit?: number
  byteLimit?: number
}

/** Converted tracks kept in memory, most recently used last: at most this many, and this many bytes of WebVTT. */
export const SUBTITLE_CACHE_LIMIT = 64
export const SUBTITLE_CACHE_BYTES = 64 * 1024 ** 2

export interface Subtitles {
  vtt: (ih: string, idx: number, track: string) => Promise<string>
  /** Cached tracks and their size, for the Debug page. */
  stats: () => { tracks: number, bytes: number, limit: number, byteLimit: number }
}

/** Converted tracks are cached, bounded by count and size; a failed conversion is forgotten so it can be retried. */
export function createSubtitles ({ engine, media, input, limit = SUBTITLE_CACHE_LIMIT, byteLimit = SUBTITLE_CACHE_BYTES }: SubtitleOptions): Subtitles {
  const cache = new Map<string, Promise<string>>()
  const sizes = new Map<string, number>() // finished tracks only
  let bytes = 0
  const forget = (key: string): void => {
    cache.delete(key)
    bytes -= sizes.get(key) ?? 0
    sizes.delete(key)
  }
  const trim = (): void => {
    for (const key of cache.keys()) {
      if (cache.size <= limit && bytes <= byteLimit) break
      if (cache.size === 1) break // the newest track is always kept, however big
      forget(key)
    }
  }
  return {
    stats: () => ({ tracks: cache.size, bytes, limit, byteLimit }),
    vtt (ih, idx, name) {
      // Embedded track N, or "file" for an external subtitle file
      const track = name.replace(/\.vtt$/, '')
      if (!/^(\d+|file)$/.test(track)) return Promise.reject(new HttpError(404, 'Not found'))
      const key = `${ih}/${idx}/${track}`
      let job = cache.get(key)
      if (job) {
        cache.delete(key) // move to the most recently used end
        cache.set(key, job)
        return job
      }
      const started = (async () => {
        const file = await engine.file(ih, idx)
        if (track === 'file' && isTextSubtitleFile(file.name)) {
          const res = await fetch(input(ih, idx))
          if (!res.ok) throw new HttpError(502, `Reading the subtitle file failed: HTTP ${res.status}`)
          if (Number(res.headers.get('content-length')) > FILE_LIMIT) throw new UnplayableError('This subtitle file is too large to be one.')
          return subtitleFileToVtt(await res.text())
        }
        if (!media.serverConversion()) {
          throw new UnplayableError(track === 'file'
            ? 'This server has no ffmpeg to convert this subtitle format; only .srt and .vtt files work here.'
            : 'This server has no ffmpeg to extract embedded subtitles; add an .srt file to the torrent folder or open the file in an external player.')
        }
        return media.subtitleToVtt(input(ih, idx), track === 'file' ? null : Number(track))
      })()
      job = started
      started.then(vtt => {
        if (cache.get(key) !== started) return
        const size = Buffer.byteLength(vtt)
        sizes.set(key, size)
        bytes += size
        trim()
      }, () => { if (cache.get(key) === started) forget(key) })
      cache.set(key, job)
      trim()
      return job
    },
  }
}
