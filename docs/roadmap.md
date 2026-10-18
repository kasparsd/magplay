# magplay: current state and roadmap

## Scope and direction

A single-user media app for a trusted local network, with no accounts. Keep the Node service and multi-page browser clients. Prioritize watching reliably on the actual device. Alongside that, finish splitting the server into isolated, strictly typed packages while it is cheap (decided 2026-10-17; see [architecture](architecture.md)); the remaining client, test and script files become TypeScript when they are next changed.

**Not for public/untrusted exposure:** there is no authentication or request-origin protection. Resource safeguards are now present, but they are not an authorization boundary. Require an authenticated gateway or application-level protection before changing that deployment assumption.

[architecture.md](architecture.md) describes package boundaries, build tooling and invariants. [user-interface.md](user-interface.md) holds UI expectations and the UI cleanup todo. This document owns priorities; [the build report](checkpoints/2026-10-17-build-report.md) is historical evidence, not the current acceptance checklist.

## Current functionality

| Area | State | Remaining limits |
| --- | --- | --- |
| Discovery | Parallel Torznab/Jackett/Prowlarr search, normalized results, source timeouts, deduplication, private download-link IDs; BitMagnet Explore/title browsing | Search waits up to the slowest source timeout; link IDs expire; Explore needs BitMagnet; title retrieval is capped at 100 upstream matches |
| Torrent/media | TCP/DHT/trackers, saved metadata, on-demand bytes, raw/tar Range/If-Range, external-player links | Public peer/NAT behavior remains network-dependent; downloads grow the torrent cache; native WebRTC dependency is loaded by WebTorrent |
| Playback | Direct MP4/WebM, HLS remux/audio conversion, opt-in video transcode, audio/subtitle selection, seeking and next episode | Unsupported video/image subtitles may require an external player; works on the real server (2026-10-17), but its conversion speed and CPU use have no recorded numbers |
| Resume | Per-file browser timestamps, Resume/Start over, HLS absolute timeline handling, completion detection, timestamped torrent action | Local browser only; no cross-device sync or audio/subtitle preference persistence; completion is a time heuristic, not credits detection |
| Lifetimes | Abortable page/play/subtitle waits, stale-result guards, countdown cleanup, tab-close fencing, raw/tar cancellation and separate metadata/checking deadlines | Browser crashes/dropped beacons still rely on idle cleanup; shared probe/torrent jobs can finish for other consumers rather than being destroyed by one cancellation |
| Resource safety | Limits on HLS sessions, torrent initialization, probes and standalone subtitle conversion; free-space admission check and soft HLS disk monitor | Not an OS quota; checks can overshoot between samples; torrent LRU preserves active data; in-memory result caches still need long-session observation |
| HTTP/static delivery | Explicit cache policies, conditional GET/HEAD, validators, safe static streaming and same-origin proxy guidance | Unversioned assets revalidate; shared proxy media caching is intentionally disabled; proxy offload has not been benchmarked |
| Deployment | Non-root Node 24 Alpine Docker image with a separate install stage, multi-platform GHCR publishing (`edge` from `main`, versions from releases), local arm64 container acceptance (rerun on Node 24 Alpine, including native `node-datachannel` on musl and Alpine ffmpeg), `.local` source names resolved through the host's avahi-daemon socket (checked in the image against a fake avahi), unit/peer/browser/typecheck/lint CI | Playback on the real server deployment confirmed by the owner (2026-10-17), without recorded timings; amd64, current Firefox/Safari/device acceptance and `.local` resolution against a real avahi-daemon are still unverified |

## Implemented in the revised sequence

1. **Checkpointed existing work:** client transport/contracts and pure media helpers, cache headers, colocated tests and architecture guidance are committed.
2. **Local Docker baseline:** an isolated generated-media check builds/runs the real image without changing the user's Compose stack. It checks probing, raw ranges, direct selection, HLS bytes, seek restart and cleanup. See [acceptance procedure](deployment-acceptance.md) and [dated validation](checkpoints/2026-10-17-local-validation.md).
3. **Resource safeguards:** defaults are two HLS sessions, four torrent initialization jobs, two probes and one standalone subtitle job. HLS has an 8 GiB soft budget and 256 MiB free-space reserve. Overload is a no-store 503 with Retry-After; there is no unbounded job queue. See [settings and tradeoffs](resources.md).
4. **Real loopback transfer:** a TCP seeder and local HTTP tracker exercise an empty cache, metadata, missing pieces, exact ranged bytes/full-file hash, disappearing/returning peers, raw/tar cancellation and dead-swarm retries. This reproduced and fixed stalled-reader cancellation and exact-piece-boundary progress reporting. See [integration tests](../tests/integration/README.md).
5. **Targeted lifecycle fixes:** explicit cancellation/timer ownership in the existing player, not a controller rewrite. Leaving before a playback response is known also closes its server session. Separate discovery and cached-piece-check deadlines bound initialization without applying a short discovery deadline to large server hash checks. See [lifetime rules](lifecycle.md).
6. **Resume/restart UX:** periodic saves plus immediate saves on playing, seeking, pause, exit and end; safe behavior for corrupt/blocked storage and nearly completed files. See [progress behavior](progress.md).
7. **Packages and TypeScript, Phases 0–2:** Node 24 baseline, npm workspaces, `tsc -b` project references and ESLint (neostandard plus type-aware rules and package-boundary rules); server and client moved into `apps/`, with esbuild bundling each page and `hls.js`; strict TypeScript packages `api-contract`, `release-info`, `seekable-tar` and `http-kit`; `toHttpError` in the server as the one place errors become statuses; the pure client helpers converted. No behavior change. See [the plan](plans/package-boundaries-and-typescript.md).
8. **Packages and TypeScript, Phases 3–4:** strict TypeScript packages `indexers` (adapters with typed parse functions and fixtures, merged search, typed indexer errors), `torrent-engine` (`createTorrentEngine` with `close()`) and `playback` (`probe`, `decide`, `ffmpegArgs`, `subtitleToVtt`, `createHlsSessions` with `close()`); the server split into `config.ts`, `app.ts`, `main.ts` (startup checks, signal handling, graceful shutdown), `services/` and `http/`, with handlers typed against `api-contract` and no work at import time; live settings reach the packages through `live()` options. `apps/server` and every package are `.ts`. No behavior change on the success paths; the failure-path differences are listed in the plan's log.
9. **UI fixes and discovery friction (items 1 and 7 of the earlier plan):** P1–P4 cleanup outside the Player, filter history, local retries, readable source errors, honest counts and truncation. See [the cleanup todo](user-interface.md#cleanup-todo).
10. **Settings page and status menu:** a status button and a Settings gear in the top bar, and one `/settings` page (Sources, Playback, Connection, Storage, Debug) driven by the shared schema. Only settings people tune are on the page; the rest stay env-only. See [the plan](plans/settings-and-status-pin.md).
11. **Player chrome, theater layout and performance graph (Player steps 1–3):** one overlay chrome for every mode, video sized to the viewport, and three Performance lanes fed by the status poll with ffmpeg `fps`/`cpu`. See [the Player roadmap](user-interface.md#player-roadmap).
12. **Hardening and long-session limits:** dependency advisory triaged and accepted; same-server redirects and 16 MiB bodies for indexers; secrets redacted from logs and diagnostics; bounded env knobs; LRU probe/subtitle caches with sizes in Debug; `/health` 503 while stopping; shutdown tests. See [resources](resources.md#in-memory-caches) and [lifecycle](lifecycle.md#server-shutdown).

13. **Application observability:** structured correlated logs, safe error serialization and bounded stdout/Debug capture; independent low-cardinality metrics and an optional private listener; explicit runtime observer/shutdown ownership and Docker rotation. See [logging architecture](logging.md), [implementation](plans/structured-logging.md) and [local evidence](checkpoints/2026-10-18-logging.md).

The earlier extraction and test-layout commits are prerequisites already delivered, not future migration tasks. No Vite, UI framework, watch-history database or general dependency-injection framework was introduced.

## Verification and confidence

- Fast colocated suite: **219 tests**. `npm test` builds the client and selects colocated `*.test.js`/`*.test.ts` under `apps/` and `packages/`, not helper modules or browser tests.
- Loopback integration: **4 runner entries** (one parent and three scenarios), selected by `npm run test:peers`.
- Chromium: **50 tests**, selected by `npm run test:e2e`; playback assertions require advancing decoded frames, not merely HTTP success.
- `npm run test:all` runs all three suites. CI also runs `npm run typecheck` and `npm run lint` (no warnings allowed). The Node 22 validation and first Docker smoke are recorded in [the final checkpoint](checkpoints/2026-10-17-local-validation.md); the isolated Docker check was rerun on Node 24 Alpine after each reorganization step, most recently after Phases 3–4 on 2026-10-18 (arm64; remux first segment 217 ms, seek-to-30 s 221 ms).
- Browser fixture media is fully cached; the separate peer suite covers uncached transfer. Both generate original data/media locally and require no public swarm or live indexer.
- Local Docker acceptance is Linux/arm64 on the development machine, **not** proof of server performance, browser rendering through the container, large-file hashing latency, or amd64 compatibility.
- Real server: on 2026-10-17 the owner reported that playback on the actual deployment works without problems. That is a qualitative result. Startup/seek timings, CPU/memory, large-cache verification and disk-pressure behaviour were not recorded, so the resource limits keep their defaults.
- Back/Forward and synthetic retained-document page transitions are tested. Actual browser BFCache eligibility is not guaranteed.
- `npm audit --omit=dev` reports four high-severity findings in the `ip` → `bittorrent-tracker` → `torrent-discovery` → `webtorrent` chain (GHSA-2p57-rm9w-gvfp, `ip.isPublic` SSRF misclassification). Triaged 2026-10-17: accepted, not exploitable here, no compatible fix exists (`ip` 2.0.1, `bittorrent-tracker` 11.2.3 and `webtorrent` 3.0.21 are all latest; the audit's only fix is a breaking downgrade to `bittorrent-tracker@0.7.3`, not used). The only `ip` call in the chain is `ipLib.toString` in `bittorrent-tracker`'s UDP *tracker-server* announce parser, which magplay never starts; `isPublic`/`isPrivate` are never called by this app, WebTorrent, torrent-discovery or the tracker client. Evidence in [the checkpoint](checkpoints/2026-10-17-ip-advisory-triage.md). Revisit if upstream drops `ip` or the app ever runs a tracker server.

## What to do next

Updated 2026-10-18, after the 2026-10-17 plan (items 1–9) was delivered; see [the waves plan](plans/roadmap-waves-2026-10-17.md). Application observability (structured logs, a small metrics baseline and bounded local collection) is implemented for real-server measurement; device acceptance can proceed independently. Centralized monitoring infrastructure remains conditional on deployment needs.

| # | Priority | Work | Completion evidence |
| --- | --- | --- | --- |
| 1 | **P1** | Check the browsers/devices actually used | Mobile controls and fullscreen, audio/subtitle switching, and unsupported-format/external-player handoff on each device in use, with the new chrome. Each failure becomes a test or a Player item. |
| 2 | **P1** | Measure on the real server | A transcode that falls behind and ffmpeg CPU in the Performance graph (Linux only); remux startup/seek timings; cache sizes in Debug over a long session. Use structured logs for server stages and device evidence for browser readiness. Record the numbers here and tune limits only if they call for it. |
| 3 | **P2** | Finish the Player checklists | The open manual checks in [Player steps 1–2](user-interface.md#player-roadmap) (layout at the listed sizes, 375 px portrait and landscape), `containerLabel` in ⓘ Details, and the remaining P4 Details item. |
| 4 | **P2** | Player in TypeScript | `player.js` (and `capabilities.js`) become TypeScript now the redesign has landed, split into small modules; no behaviour change. |
| 5 | **P2** | Changesets and application changelog ([plan](plans/changesets-changelog.md)) | One application version and generated changelog owned by the server workspace; release notes alongside changes, explicit version preparation, and CI checks for missing/invalid notes. Manual GitHub Releases reuse existing versioned Docker publishing. Planned, not implemented. |
| 6 | **P3** | TypeScript Phase 7 review | The [plan](plans/package-boundaries-and-typescript.md)'s tighten-and-document pass; other client pages, tests and scripts still convert on touch. |
| 7 | **P3 / conditional** | Interface translation ([i18n plan](plans/i18n-support.md)) | Only if a second interface language is wanted, starting with `Intl.PluralRules` plus one catalog. |
| 8 | **P3 / conditional** | Fingerprinted client assets | Only if revalidating unversioned bundles becomes a measured problem. |
| 9 | **P3 / conditional** | Browser remux or cross-origin hosting | Only for a demonstrated server CPU/compatibility or deployment need. |

**Do not automatically schedule a playback-controller extraction, accounts or a framework migration.** These are conditional scope changes, not missing product features. Logging and the remaining Player work must preserve the [lifetime rules](lifecycle.md), including shared-job ownership and cancellation behavior.

Before public/untrusted exposure, authentication, media/API access protection and Origin/CSRF handling become mandatory deployment gates. They are intentionally not account features on the local-only roadmap.

## Backburner

These items are planned for later and are not part of the active sequence above. Reprioritize explicitly before starting implementation.

- [ ] **Electron desktop distribution for Windows, macOS and Linux** ([finalized plan](plans/desktop-packaging.md), [architecture](architecture.md#desktop-distribution-direction)). Package the existing UI in its own application window with a supervised Node backend and bundled FFmpeg/ffprobe; retain the headless/Docker distribution. First prove packaged playback and native torrent dependencies on each OS, then implement portable paths, Windows throttling/process cleanup, desktop behavior, installers and signing. No implementation has started; no release date is scheduled. Automatic updates, tray/background mode and a browser-only launcher are outside the first release scope.

## Boundaries to preserve

- `/raw` remains the single source of torrent bytes for direct playback, downloads, external players and ffmpeg/ffprobe. Keep Range, validators and cancellation consistent with `/tar`.
- Node owns indexer secrets, torrent discovery/cache, probing and server conversion. Static pages consume API/media contracts; a UI framework should not acquire those responsibilities.
- Same-origin Nginx static offload is already possible and does not imply CORS, accounts or a separate-origin client. Respect origin headers and avoid buffering live media.
- Maintain colocated fast tests and separate `tests/integration/` / `tests/e2e/` suites. Keep fixtures/tests out of production static/Docker artifacts.
- Keep policy/codec/timestamp helpers small and testable. Package boundaries follow [architecture.md](architecture.md) and are enforced by lint; within a package, prefer direct, local fixes over abstraction for its own sake.
