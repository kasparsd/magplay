# magplay: current state and roadmap

## Scope and direction

A single-user media app for a trusted local network/NAS, with no accounts. Keep the Node service and multi-page browser clients. Prioritize watching reliably on the actual device. Alongside that, reorganize the code into isolated packages and strict TypeScript now, while it is cheap (decided 2026-10-17; see [architecture](architecture.md)).

**Not for public/untrusted exposure:** there is no authentication or request-origin protection. Resource safeguards are now present, but they are not an authorization boundary. Require an authenticated gateway or application-level protection before changing that deployment assumption.

[architecture.md](architecture.md) describes package boundaries, build tooling and invariants. This document owns priorities; [the build report](checkpoints/2026-10-17-build-report.md) is historical evidence, not the current acceptance checklist.

## Current functionality

| Area | State | Remaining limits |
| --- | --- | --- |
| Discovery | Parallel Torznab/Jackett/Prowlarr search, normalized results, source timeouts, deduplication, private download-link IDs; BitMagnet Explore/title browsing | Search waits up to the slowest source timeout; link IDs expire; Explore needs BitMagnet; title retrieval is capped at 100 upstream matches |
| Torrent/media | TCP/DHT/trackers, saved metadata, on-demand bytes, raw/tar Range/If-Range, external-player links | Public peer/NAT behavior remains network-dependent; downloads grow the torrent cache; native WebRTC dependency is loaded by WebTorrent |
| Playback | Direct MP4/WebM, HLS remux/audio conversion, opt-in video transcode, audio/subtitle selection, seeking and next episode | Unsupported video/image subtitles may require an external player; NAS conversion performance remains unmeasured |
| Resume | Per-file browser timestamps, Resume/Start over, HLS absolute timeline handling, completion detection, timestamped torrent action | Local browser only; no cross-device sync or audio/subtitle preference persistence; completion is a time heuristic, not credits detection |
| Lifetimes | Abortable page/play/subtitle waits, stale-result guards, countdown cleanup, tab-close fencing, raw/tar cancellation and separate metadata/checking deadlines | Browser crashes/dropped beacons still rely on idle cleanup; shared probe/torrent jobs can finish for other consumers rather than being destroyed by one cancellation |
| Resource safety | Limits on HLS sessions, torrent initialization, probes and standalone subtitle conversion; free-space admission check and soft HLS disk monitor | Not an OS quota; checks can overshoot between samples; torrent LRU preserves active data; in-memory result caches still need long-session observation |
| HTTP/static delivery | Explicit cache policies, conditional GET/HEAD, validators, safe static streaming and same-origin proxy guidance | Unversioned assets revalidate; shared proxy media caching is intentionally disabled; proxy offload has not been benchmarked |
| Deployment | Non-root Node 22 Docker image, local arm64 container acceptance, unit/peer/browser CI configuration | Actual NAS, amd64 and current Firefox/Safari/device acceptance are still unverified in this work |

## Implemented in the revised sequence

1. **Checkpointed existing work:** client transport/contracts and pure media helpers, cache headers, colocated tests and architecture guidance are committed.
2. **Local Docker baseline:** an isolated generated-media check builds/runs the real image without changing the user's Compose stack. It checks probing, raw ranges, direct selection, HLS bytes, seek restart and cleanup. See [acceptance procedure](deployment-acceptance.md) and [dated validation](checkpoints/2026-10-17-local-validation.md).
3. **Resource safeguards:** defaults are two HLS sessions, four torrent initialization jobs, two probes and one standalone subtitle job. HLS has an 8 GiB soft budget and 256 MiB free-space reserve. Overload is a no-store 503 with Retry-After; there is no unbounded job queue. See [settings and tradeoffs](resources.md).
4. **Real loopback transfer:** a TCP seeder and local HTTP tracker exercise an empty cache, metadata, missing pieces, exact ranged bytes/full-file hash, disappearing/returning peers, raw/tar cancellation and dead-swarm retries. This reproduced and fixed stalled-reader cancellation and exact-piece-boundary progress reporting. See [integration tests](../tests/integration/README.md).
5. **Targeted lifecycle fixes:** explicit cancellation/timer ownership in the existing player, not a controller rewrite. Leaving before a playback response is known also closes its server session. Separate discovery and cached-piece-check deadlines bound initialization without applying a short discovery deadline to large NAS hash checks. See [lifetime rules](lifecycle.md).
6. **Resume/restart UX:** periodic saves plus immediate saves on playing, seeking, pause, exit and end; safe behavior for corrupt/blocked storage and nearly completed files. See [progress behavior](progress.md).

The earlier extraction and test-layout commits are prerequisites already delivered, not future migration tasks. No Vite, UI framework, watch-history database or general dependency-injection framework was introduced.

## Verification and confidence

- Fast colocated suite: **108 tests**. `npm test` selects `src/**/*.test.js` and `public/**/*.test.js`, not helper modules or browser tests.
- Loopback integration: **4 runner entries** (one parent and three scenarios), selected by `npm run test:peers`.
- Chromium: **19 tests**, selected by `npm run test:e2e`; playback assertions require advancing decoded frames, not merely HTTP success.
- `npm run test:all` runs all three suites. Node 22 validation and the local Docker smoke are recorded in [the final checkpoint](checkpoints/2026-10-17-local-validation.md). Syntax and whitespace checks are also run.
- Browser fixture media is fully cached; the separate peer suite covers uncached transfer. Both generate original data/media locally and require no public swarm or live indexer.
- Local Docker acceptance is Linux/arm64 on the development machine, **not** proof of NAS performance, browser rendering through the container, large-file hashing latency, or amd64 compatibility.
- Back/Forward and synthetic retained-document page transitions are tested. Actual browser BFCache eligibility is not guaranteed.
- `npm audit --omit=dev` reported four high-severity findings in the `ip` → `bittorrent-tracker` → `torrent-discovery` → `webtorrent` dependency chain (GHSA-2p57-rm9w-gvfp). The proposed forced fix is an incompatible WebTorrent downgrade. These are dependency findings, not demonstrated application exploits; investigate reachability and compatible upstream fixes rather than forcing the downgrade.

## What to do next

| Priority | Work | Completion evidence |
| --- | --- | --- |
| **P1** | **Validate representative playback on the NAS** | Record cold/warm startup, seeking, peak/sustained CPU/memory, ffmpeg speed, large-cache verification and disk-pressure behavior using the actual deployment and typical media. Follow [the acceptance procedure](deployment-acceptance.md). Tune limits from those results. |
| **P1** | **Package boundaries, TypeScript and linting** | All first-party code lives in `packages/*` and `apps/*` as strict TypeScript under ESLint; core packages throw typed errors instead of HTTP statuses; no work at import time and every resource owner has `close()`; server and client share `api-contract`; typecheck, lint, unit, peer, e2e and Docker checks pass. Tracked in [the plan](plans/package-boundaries-and-typescript.md). Runs in parallel with NAS validation, which is mostly manual measurement. |
| **P1** | Triage the dependency advisory | Record relevant vulnerable call paths and exposure, then adopt a compatible patch/upgrade or explicitly document the accepted mitigation. Preserve peer/media regressions. |
| **P2** | Check the browsers/devices actually used | Exercise mobile controls/fullscreen, audio/subtitle switching and unsupported-format/external-player handoff. Add automated cases for observed failures, not a speculative matrix of every device. |
| **P2** | Improve discovery/navigation where use shows friction | Intentional filter history/Back behavior, visible local retries, selected genres outside the top chips, useful source errors without hover-only explanations, honest title-list truncation. Avoid unrelated page migrations. |
| **P2** | Finish boundary/error hardening incrementally | Validate remaining ports/timeouts/cache settings and upstream shapes/URL schemes; bound indexer bodies/redirect policy; keep secrets out of logs. New resource settings already reject invalid values. |
| **P2** | Observe long-session cache/shutdown behavior | Add TTL/size limits for probe/subtitle memory if warranted, readiness/diagnostics useful for troubleshooting, and targeted graceful-shutdown tests built on the package factories. |
| **P3 / conditional** | Fingerprinted client assets | The esbuild client build arrives with TypeScript; add content hashes and immutable caching only if revalidating unversioned assets becomes a measured problem. Preserve multi-page URLs, Node-only deployment and media cache/range semantics; test the production artifact. |
| **P3 / conditional** | Browser remux or cross-origin hosting | Prototype only for a demonstrated NAS CPU/compatibility or deployment need. Measure seeking, memory and fallback behavior first. General browser video transcoding is not planned. |

**Do not automatically schedule a playback-controller extraction, accounts or a framework migration.** These are conditional scope changes, not missing product features. The current player can be split further if future fixes become materially easier that way. The package/TypeScript reorganization above is the one scheduled structural change, and it must not change behavior.

Before public/untrusted exposure, authentication, media/API access protection and Origin/CSRF handling become mandatory deployment gates. They are intentionally not account features on the local-only roadmap.

## Boundaries to preserve

- `/raw` remains the single source of torrent bytes for direct playback, downloads, external players and ffmpeg/ffprobe. Keep Range, validators and cancellation consistent with `/tar`.
- Node owns indexer secrets, torrent discovery/cache, probing and server conversion. Static pages consume API/media contracts; a UI framework should not acquire those responsibilities.
- Same-origin Nginx static offload is already possible and does not imply CORS, accounts or a separate-origin client. Respect origin headers and avoid buffering live media.
- Maintain colocated fast tests and separate `tests/integration/` / `tests/e2e/` suites. Keep fixtures/tests out of production static/Docker artifacts.
- Keep policy/codec/timestamp helpers small and testable. Package boundaries follow [architecture.md](architecture.md); within a package, prefer direct, local fixes over abstraction for its own sake.
