# Plan: opt-in seeding of completed torrents

## Goal

Let magplay give completed downloads back to the swarm without hurting playback or the cache and resource limits. Sharing is on until a download has uploaded its own size, and can be turned off.

## Motivation

Torrents load on demand (`deselect: true`). In-order streaming gives little back to the swarm, so a finished download keeps sharing until it has uploaded its own size.

## Owner decision (2026-10-19)

- Settings are only a toggle (`seeding.enabled`, default on, `SEEDING_ENABLED`) and a ratio (`seeding.ratio`: 0.5×, 1×, 2×, 5×, default 1×, `SEEDING_RATIO`), in Storage under a "Sharing" group. The ratio is disabled, not hidden, while sharing is off. The default ratio means upload the torrent's size once, then stop. It is not a split of download and upload bandwidth.
- The app, not the user, owns concurrency, upload rate, idle unloading and playback priority. No upload-limit, max-torrents or idle-timeout settings, no per-torrent controls, no Debug or torrent-page UI.

## Design

- The live engine option is `seeding: { enabled, ratio }`, read from `live()` on each use.
- Only a torrent that is already loaded and complete (`done` or `progress === 1`) is seeded. Partial torrents never are, and the cache is not scanned to load torrents the user has not opened.
- The ratio uses the torrent's size. WebTorrent's `uploaded` restarts at zero on every add, so `<cache>/<infoHash>/seed.json` stores `{ uploaded }`; the running total is the file's value at load plus this session's `torrent.uploaded`. Housekeeping writes it, as does every unload and `close()`. A zero-length torrent is never seeded.
- Reaching the ratio stops seeding. Without an open stream or pending load the handle is destroyed so it stops announcing; the data stays. Nothing is flagged permanently, so a higher ratio lets the next load seed it again.
- Engine constants: `MAX_SEEDED = 3` (oldest seeded without a stream or pending load are unloaded first; the cap is soft while extras are watched), `PLAYBACK_UPLOAD_BYTES_PER_SEC = 128 KiB/s` while any stream is open, no throttle (`throttleUpload(-1)`) otherwise, and `SEED_IDLE_MS = 24 h` with no peers and no upload before unloading.
- Every housekeeping pass, including the first, applies the throttle, so a settings change needs no restart. Turning seeding off unloads seeded torrents that are not streaming or loading and marks no new ones.
- Eviction deletes non-seeded LRU folders first, then the oldest seeded, unloading a seeded torrent before deleting its folder. A torrent with an open stream or a pending load is never unloaded or deleted. Seeding never bypasses `cacheMaxBytes`.
- `stats()` reports `seeded` (count) and `uploadSpeed` (sum) alongside `loads` and `loaded`.

## Work items

- [x] Settings schema: `seeding.enabled` toggle and `seeding.ratio` segmented control with a disable rule; help text kept clear of the settings e2e denylist.
- [x] `Config.seedingEnabled`/`seedingRatio`, `LiveOptions.seeding`, `DEFAULT_LIVE` and the `live()` factory in `app.ts`.
- [x] README env table: `SEEDING_ENABLED`, `SEEDING_RATIO`.
- [x] Engine: completion detection, `seed.json` totals, ratio stop, cap, 24 h idle unload, playback upload throttle, disable path, listeners registered once per added torrent.
- [x] Eviction order in `store.ts`: non-seeded first, then oldest seeded; open streams and pending loads protected.
- [x] Tests in `engine.test.ts`: seeding off, retention past the playback idle timeout, ratio reached, partial torrent, open stream versus cap and eviction, eviction order, throttle with and without a stream.
- [x] Roadmap, resources and changeset.

## Not in this change

- Listen-port reachability feedback. Seeding only helps the swarm when `TORRENT_PORT` is reachable from outside.
- A seeding badge or upload speed on the torrent page.
