// Interim, until the server split (Phase 4): the media tools, HLS sessions and tab fencing for server.js.
import path from 'node:path'
import { createHlsSessions, createMediaTools } from '@magplay/playback'
import config from './config-instance.js'
import { createTabs } from './services/tabs.ts'

/** ffmpeg and ffprobe read torrent files through /raw on the loopback address. */
export const rawUrl = (ih, idx) => `http://127.0.0.1:${config.port}/raw/${ih}/${idx}`

export const media = createMediaTools({
  live: () => ({ ffprobePath: config.ffprobePath, ffmpegPath: config.ffmpegPath, maxProbes: config.maxProbes, maxSubtitleJobs: config.maxSubtitleJobs }),
})

export const tabs = createTabs(() => hls)

const hlsDir = path.join(config.cacheDir, 'hls')
let hls
try {
  hls = createHlsSessions({
    dir: hlsDir,
    live: () => ({ ffmpegPath: config.ffmpegPath, maxSessions: config.maxHlsSessions, hlsMaxBytes: config.hlsMaxBytes, minFreeBytes: config.minFreeBytes, transcodeMaxHeight: config.transcodeMaxHeight }),
    onStop: tabs.forget,
  })
} catch (err) {
  console.error(`Cannot create the cache directory ${hlsDir} (${err.message}). Set CACHE_DIR to a writable location, e.g. CACHE_DIR=./data`)
  process.exit(1)
}
export { hls }

// Paused (SIGSTOPped) ffmpegs would outlive us, so kill them on shutdown
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    hls.stopAll()
    process.exit(0)
  })
}
