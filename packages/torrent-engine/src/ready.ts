// Waiting for a torrent's file list, with separate deadlines for finding metadata and for checking cached pieces.
import type { EventEmitter } from 'node:events'
import { TorrentFailedError, TorrentTimeoutError } from './errors.ts'

/** What waitForTorrent needs from a WebTorrent torrent. */
export interface Pending extends Pick<EventEmitter, 'once' | 'off'> {
  ready: boolean
  metadata?: unknown
  destroy: () => void
}

/** Bound metadata discovery separately from potentially long cached-piece checking. */
export function waitForTorrent<T extends Pending> (torrent: T, { metadataMs, checkingMs }: { metadataMs: number, checkingMs: number }): Promise<T> {
  return new Promise((resolve, reject) => {
    let timer: NodeJS.Timeout | undefined
    const done = (): void => {
      clearTimeout(timer)
      torrent.off('metadata', metadata)
      torrent.off('ready', ready)
      torrent.off('error', error)
      torrent.off('close', closed)
    }
    const arm = (ms: number, message: string): void => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        done()
        torrent.destroy()
        reject(new TorrentTimeoutError(message))
      }, ms)
    }
    const metadata = (): void => arm(checkingMs, 'Checking cached torrent data took too long. Retry or increase TORRENT_CHECK_TIMEOUT_S for large files.')
    const ready = (): void => { done(); resolve(torrent) }
    const error = (err: unknown): void => {
      done()
      reject(new TorrentFailedError(`Torrent error: ${err instanceof Error ? err.message : String(err)}`))
    }
    const closed = (): void => { done(); reject(new TorrentFailedError('Torrent closed before its file list was ready. Try again.')) }
    torrent.once('ready', ready)
    torrent.once('error', error)
    torrent.once('metadata', metadata)
    torrent.once('close', closed)
    if (torrent.ready) ready()
    else if (torrent.metadata) metadata()
    else arm(metadataMs, `No peers found for this torrent in ${metadataMs / 1000} s; try another release`)
  })
}
