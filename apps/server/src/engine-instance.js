// Interim, until the server split (Phase 4): the one torrent engine for the modules that still use module state.
import path from 'node:path'
import { createTorrentEngine } from '@magplay/torrent-engine'
import config from './config-instance.js'

export const engine = createTorrentEngine({
  dir: path.join(config.cacheDir, 'torrents'),
  port: config.torrentPort,
  dht: config.dhtEnabled,
  lsd: config.lsdEnabled,
  live: () => ({
    maxLoads: config.maxTorrentLoads,
    extraTrackers: config.extraTrackers,
    metadataTimeoutMs: config.metadataTimeoutMs,
    checkingTimeoutMs: config.checkingTimeoutMs,
    idleMs: config.idleTorrentMs,
    cacheMaxBytes: config.cacheMaxBytes,
  }),
})
