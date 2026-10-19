# Plan: opt-in seeding of completed torrents

## Goal

Let magplay contribute completed pieces back to the swarm, on an opt-in basis, while preserving the resource and cache limits that currently unload idle torrents.

## Motivation

magplay is a leecher today: torrents are loaded on demand (`deselect: true`) and destroyed once idle (`housekeeping()` calls `t.destroy()`). The torrent-streaming article (Kragujević) notes that in-order streaming gives nothing back to the swarm; seeding completed downloads is the ethical middle ground. This is a backburner item (see roadmap.md).

## Scope

- New settings `seeding.enabled` (default off), `seeding.uploadSpeedLimitBytesPerSec` (or a friendlier KB/s unit in the UI), and `seeding.maxTorrents`.
- A separate seeding idle timeout (longer than playback's), or an explicit "no peers / no upload" condition.
- Keep completed torrents loaded instead of destroying them when idle, up to `maxTorrents`.
- Skip cache eviction for seeded data until necessary; unload and evict the oldest seeded torrent first under disk pressure.
- Surface seeding state (peers, upload speed, seeded count) in the torrent page and Debug view.
- Upload throttle passed to the WebTorrent client, applied dynamically when settings change.
- Per-torrent "stop seeding" control and port-reachability feedback.

## Boundaries to preserve

- Default-off: current leecher behavior unchanged, including default upload throttle of 0.
- Seeding must not starve playback: upload limit, cap on seeded torrents, and skipping active streams when enforcing the cap.
- Keep `torrentPort` reachability documented and surfaced; seeding is ineffective otherwise.
- Don't break cache LRU or resource limits; seeding torrents count against them.
- Seeding stops automatically when disk pressure evicts that torrent's data.

## Design decisions from review

- "Completed" means `progress === 1` / `downloaded === length`, detected via WebTorrent's `'done'` event and verified in `housekeeping()`. Partially downloaded torrents are never treated as seedable.
- Track a set of seeded info hashes in the engine so retention, eviction, stats, and UI can distinguish seeded from merely loaded torrents.
- Seeded torrents are not subject to the playback idle timeout while under `maxTorrents`; the separate timeout only applies as a fallback for seeded torrents with no peers and no upload for an extended period.
- When enforcing `maxTorrents`, skip torrents with open streams; the cap may be temporarily soft until they finish.
- Under disk pressure, unload the oldest seeded torrent first, then evict. Evict non-seeded LRU data before seeded data. Never let seeding bypass `cacheMaxBytes`.
- The upload cap is global, matching WebTorrent's single `throttleGroups.up`. Per-torrent caps are unnecessary because `maxTorrents` already bounds total work.
- Settings apply without a restart, so the engine must call `client.throttleUpload()` on changes and unload seeded torrents when seeding is disabled.
- Upload limits should be expressed in a human-friendly unit (KB/s or MB/s) in the UI, converted to bytes/sec in `deriveSettings`.

## Work items

- [ ] Add settings schema entries + UI in `/settings`, including env vars (`SEEDING_ENABLED`, `SEEDING_UPLOAD_LIMIT_BYTES_PER_SEC`, `SEEDING_MAX_TORRENTS`, and a seeding idle timeout).
- [ ] Add seeding fields to `Config`, `LiveOptions`, `DEFAULT_LIVE`, and the `live()` factory in `app.ts`.
- [ ] Modify `housekeeping()` to retain seeded torrents, enforce `maxTorrents`, and handle completion detection.
- [ ] Add eviction ordering: non-seeded LRU first, then oldest seeded; unload before evict.
- [ ] Hook WebTorrent `'done'` events to mark torrents as seeded when enabled.
- [ ] Apply upload throttle to WebTorrent client options and via `client.throttleUpload()` on setting changes.
- [ ] Unload seeded torrents and reset throttle when seeding is disabled.
- [ ] Extend `stats()` and `DebugInfo` with seeded count and total upload speed.
- [ ] Add seeding status (upload speed, "seeding" badge) to the torrent page activity line.
- [ ] Add per-torrent "stop seeding" control and port-reachability feedback.
- [ ] Add consent/privacy copy to settings help text.
- [ ] Tests: retention, completion-triggered seeding, eviction exemption and seeded-first eviction, soft cap with active streams, default-off byte-identical behavior, throttle applied on toggle.
- [ ] Changeset (minor, since this adds user-facing settings).

## Open questions (resolved)

- Should seeding stop automatically when disk pressure triggers eviction of that torrent? Yes.
- Should there be a global upload cap separate from per-torrent? The single global cap is sufficient and matches WebTorrent's throttle group.

## Review findings folded in

### Gaps and edge cases

- Completion detection is undefined in the original plan; it must be explicit.
- Partial torrents must not be seeded.
- Seeded vs. loaded distinction is missing from engine state and stats.
- Dynamic settings are not handled by "pass upload limit to client options" alone.
- The "idle while seeding" semantics are contradictory without a no-peer/no-upload condition.
- `maxTorrents` must not kill active streams.
- Eviction priority must be specified to avoid breaking `cacheMaxBytes`.
- Settings need section, scope, env vars, validation, and a fourth idle-timeout setting.
- Per-torrent control and port reachability are missing but important for UX.
- Privacy/consent copy is missing.

### Performance implications

- Memory scales with retained torrents; default `maxTorrents` should be small (3-5).
- Each retained torrent keeps announcing to trackers and DHT; the cap is a resource knob.
- Seeding reads from disk and can contend with playback; consider pausing seeding on torrents with active streams.
- Reuse the existing housekeeping pass instead of adding a second full-tree walk.
- Hook `'done'` events rather than polling progress.

### UX implications

- The torrent page activity line must show `↑ speed` and a "seeding" badge; otherwise a completed torrent looks inactive.
- Debug view needs seeded count and total upload speed, requiring contract changes.
- Bytes/sec is not a usable setting unit; prefer KB/s or MB/s.
- Port unreachability must be reported honestly rather than showing a green seeding state.
- Users streaming single episodes will never reach "completed"; settings help and the torrent page should state this.
- Seeding settings fit best in the `storage` section under a "Seeding" group.