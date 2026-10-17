import { HttpError } from './errors.ts'

/** Bound metadata discovery separately from potentially long cached-piece checking. */
export function waitForTorrent (torrent, { metadataMs, checkingMs }) {
  return new Promise((resolve, reject) => {
    let timer
    const done = () => {
      clearTimeout(timer)
      torrent.off('metadata', metadata)
      torrent.off('ready', ready)
      torrent.off('error', error)
      torrent.off('close', closed)
    }
    const arm = (ms, message) => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        done()
        torrent.destroy()
        reject(new HttpError(504, message))
      }, ms)
    }
    const metadata = () => arm(checkingMs, 'Checking cached torrent data took too long. Retry or increase TORRENT_CHECK_TIMEOUT_S for large files.')
    const ready = () => { done(); resolve(torrent) }
    const error = err => { done(); reject(new HttpError(502, `Torrent error: ${err.message || err}`)) }
    const closed = () => { done(); reject(new HttpError(502, 'Torrent closed before its file list was ready. Try again.')) }
    torrent.once('ready', ready)
    torrent.once('error', error)
    torrent.once('metadata', metadata)
    torrent.once('close', closed)
    if (torrent.ready) ready()
    else if (torrent.metadata) metadata()
    else arm(metadataMs, `No peers found for this torrent in ${metadataMs / 1000} s; try another release`)
  })
}
