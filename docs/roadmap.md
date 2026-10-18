# magplay: current state and roadmap

## Scope and direction

A single-user media app for a trusted local network/NAS, with no accounts. Keep the Node service and multi-page browser clients. Prioritize watching reliably on the actual device. Alongside that, finish splitting the server into isolated, strictly typed packages while it is cheap (decided 2026-10-17; see [architecture](architecture.md)); the remaining client, test and script files become TypeScript when they are next changed.

**Not for public/untrusted exposure:** there is no authentication or request-origin protection. Resource safeguards are now present, but they are not an authorization boundary. Require an authenticated gateway or application-level protection before changing that deployment assumption.

[architecture.md](architecture.md) describes package boundaries, build tooling and invariants. [user-interface.md](user-interface.md) holds UI expectations and the UI cleanup todo. This document owns priorities; [the build report](checkpoints/2026-10-17-build-report.md) is historical evidence, not the current acceptance checklist.

## Current functionality

| Area | State | Remaining limits |
| --- | --- | --- |
| Discovery | Parallel Torznab/Jackett/Prowlarr search, normalized results, source timeouts, deduplication, private download-link IDs; BitMagnet Explore/title browsing | Search waits up to the slowest source timeout; link IDs expire; Explore needs BitMagnet; title retrieval is capped at 100 upstream matches |
| Torrent/media | TCP/DHT/trackers, saved metadata, on-demand bytes, raw/tar Range/If-Range, external-player links | Public peer/NAT behavior remains network-dependent; downloads grow the torrent cache; native WebRTC dependency is loaded by WebTorrent |
| Playback | Direct MP4/WebM, HLS remux/audio conversion, opt-in video transcode, audio/subtitle selection, seeking and next episode | Unsupported video/image subtitles may require an external player; works on the real NAS (2026-10-17), but its conversion speed and CPU use have no recorded numbers |
| Resume | Per-file browser timestamps, Resume/Start over, HLS absolute timeline handling, completion detection, timestamped torrent action | Local browser only; no cross-device sync or audio/subtitle preference persistence; completion is a time heuristic, not credits detection |
| Lifetimes | Abortable page/play/subtitle waits, stale-result guards, countdown cleanup, tab-close fencing, raw/tar cancellation and separate metadata/checking deadlines | Browser crashes/dropped beacons still rely on idle cleanup; shared probe/torrent jobs can finish for other consumers rather than being destroyed by one cancellation |
| Resource safety | Limits on HLS sessions, torrent initialization, probes and standalone subtitle conversion; free-space admission check and soft HLS disk monitor | Not an OS quota; checks can overshoot between samples; torrent LRU preserves active data; in-memory result caches still need long-session observation |
| HTTP/static delivery | Explicit cache policies, conditional GET/HEAD, validators, safe static streaming and same-origin proxy guidance | Unversioned assets revalidate; shared proxy media caching is intentionally disabled; proxy offload has not been benchmarked |
| Deployment | Non-root Node 24 Alpine Docker image with a separate install stage, multi-platform GHCR publishing (`edge` from `main`, versions from releases), local arm64 container acceptance (rerun on Node 24 Alpine, including native `node-datachannel` on musl and Alpine ffmpeg), `.local` source names resolved through the host's avahi-daemon socket (checked in the image against a fake avahi), unit/peer/browser/typecheck/lint CI | Playback on the real NAS deployment confirmed by the owner (2026-10-17), without recorded timings; amd64, current Firefox/Safari/device acceptance and `.local` resolution against a real avahi-daemon are still unverified |

## Implemented in the revised sequence

1. **Checkpointed existing work:** client transport/contracts and pure media helpers, cache headers, colocated tests and architecture guidance are committed.
2. **Local Docker baseline:** an isolated generated-media check builds/runs the real image without changing the user's Compose stack. It checks probing, raw ranges, direct selection, HLS bytes, seek restart and cleanup. See [acceptance procedure](deployment-acceptance.md) and [dated validation](checkpoints/2026-10-17-local-validation.md).
3. **Resource safeguards:** defaults are two HLS sessions, four torrent initialization jobs, two probes and one standalone subtitle job. HLS has an 8 GiB soft budget and 256 MiB free-space reserve. Overload is a no-store 503 with Retry-After; there is no unbounded job queue. See [settings and tradeoffs](resources.md).
4. **Real loopback transfer:** a TCP seeder and local HTTP tracker exercise an empty cache, metadata, missing pieces, exact ranged bytes/full-file hash, disappearing/returning peers, raw/tar cancellation and dead-swarm retries. This reproduced and fixed stalled-reader cancellation and exact-piece-boundary progress reporting. See [integration tests](../tests/integration/README.md).
5. **Targeted lifecycle fixes:** explicit cancellation/timer ownership in the existing player, not a controller rewrite. Leaving before a playback response is known also closes its server session. Separate discovery and cached-piece-check deadlines bound initialization without applying a short discovery deadline to large NAS hash checks. See [lifetime rules](lifecycle.md).
6. **Resume/restart UX:** periodic saves plus immediate saves on playing, seeking, pause, exit and end; safe behavior for corrupt/blocked storage and nearly completed files. See [progress behavior](progress.md).
7. **Packages and TypeScript, Phases 0–2:** Node 24 baseline, npm workspaces, `tsc -b` project references and ESLint (neostandard plus type-aware rules and package-boundary rules); server and client moved into `apps/`, with esbuild bundling each page and `hls.js`; strict TypeScript packages `api-contract`, `release-info`, `seekable-tar` and `http-kit`; `toHttpError` in the server as the one place errors become statuses; the pure client helpers converted. No behavior change. See [the plan](plans/package-boundaries-and-typescript.md).
8. **Packages and TypeScript, Phases 3–4:** strict TypeScript packages `indexers` (adapters with typed parse functions and fixtures, merged search, typed indexer errors), `torrent-engine` (`createTorrentEngine` with `close()`) and `playback` (`probe`, `decide`, `ffmpegArgs`, `subtitleToVtt`, `createHlsSessions` with `close()`); the server split into `config.ts`, `app.ts`, `main.ts` (startup checks, signal handling, graceful shutdown), `services/` and `http/`, with handlers typed against `api-contract` and no work at import time; live settings reach the packages through `live()` options. `apps/server` and every package are `.ts`. No behavior change on the success paths; the failure-path differences are listed in the plan's log.

The earlier extraction and test-layout commits are prerequisites already delivered, not future migration tasks. No Vite, UI framework, watch-history database or general dependency-injection framework was introduced.

## Verification and confidence

- Fast colocated suite: **178 tests**. `npm test` builds the client and selects colocated `*.test.js`/`*.test.ts` under `apps/` and `packages/`, not helper modules or browser tests.
- Loopback integration: **4 runner entries** (one parent and three scenarios), selected by `npm run test:peers`.
- Chromium: **39 tests**, selected by `npm run test:e2e`; playback assertions require advancing decoded frames, not merely HTTP success.
- `npm run test:all` runs all three suites. CI also runs `npm run typecheck` and `npm run lint` (no warnings allowed). The Node 22 validation and first Docker smoke are recorded in [the final checkpoint](checkpoints/2026-10-17-local-validation.md); the isolated Docker check was rerun on Node 24 Alpine after each reorganization step, most recently after Phases 3–4 on 2026-10-18 (arm64; remux first segment 217 ms, seek-to-30 s 221 ms).
- Browser fixture media is fully cached; the separate peer suite covers uncached transfer. Both generate original data/media locally and require no public swarm or live indexer.
- Local Docker acceptance is Linux/arm64 on the development machine, **not** proof of NAS performance, browser rendering through the container, large-file hashing latency, or amd64 compatibility.
- Real NAS: on 2026-10-17 the owner reported that playback on the actual deployment works without problems. That is a qualitative result. Startup/seek timings, CPU/memory, large-cache verification and disk-pressure behaviour were not recorded, so the resource limits keep their defaults.
- Back/Forward and synthetic retained-document page transitions are tested. Actual browser BFCache eligibility is not guaranteed.
- `npm audit --omit=dev` reports four high-severity findings in the `ip` → `bittorrent-tracker` → `torrent-discovery` → `webtorrent` chain (GHSA-2p57-rm9w-gvfp, `ip.isPublic` SSRF misclassification). Triaged 2026-10-17: accepted, not exploitable here, no compatible fix exists (`ip` 2.0.1, `bittorrent-tracker` 11.2.3 and `webtorrent` 3.0.21 are all latest; the audit's only fix is a breaking downgrade to `bittorrent-tracker@0.7.3`, not used). The only `ip` call in the chain is `ipLib.toString` in `bittorrent-tracker`'s UDP *tracker-server* announce parser, which magplay never starts; `isPublic`/`isPrivate` are never called by this app, WebTorrent, torrent-discovery or the tracker client. Evidence in [the checkpoint](checkpoints/2026-10-17-ip-advisory-triage.md). Revisit if upstream drops `ip` or the app ever runs a tracker server.

## What to do next

Reordered on 2026-10-17 after Phases 0–2 of the TypeScript work landed. Work top to bottom; items in the same priority can run in parallel where they don't touch the same files.

| # | Priority | Work | Completion evidence |
| --- | --- | --- | --- |
| 1 | **P1** | **Fix the known broken UI behaviour** (done 2026-10-17, no new e2e case) | Every item under [P1: broken behaviour](user-interface.md#p1-broken-behaviour) is ticked: the clipped More menu, `[hidden]` being overridden, stale Explore genres, invalid Explore `type`, and the unknown-file Player state. Add an e2e case where it is cheap. |
| 2 | **P1** | Triage the dependency advisory (done 2026-10-17: accepted, see Verification and confidence) | Record whether the vulnerable `ip` call paths are reachable here and what is exposed, then adopt a compatible patch/upgrade or document the accepted mitigation. Preserve peer/media regressions. |
| 3 | **P1** | **TypeScript Phases 3–4: indexers, torrent engine, playback, server split** (done 2026-10-18, see delivered item 8) | The [plan](plans/package-boundaries-and-typescript.md)'s Phases 3 and 4 are done: `indexers`, `torrent-engine` and `playback` packages; factories with `close()` and no work at import time; `main.ts` with graceful shutdown and a test for it; server handlers typed against `api-contract`. No behaviour change; every suite and the Docker check pass. |
| 4 | **P2** | Check the browsers/devices actually used | Before item 5: mobile controls and fullscreen, audio/subtitle switching, and unsupported-format/external-player handoff on each device in use. Turn each observed failure into a test or a Player roadmap item, not a speculative matrix of every device. |
| 5 | **P2** | Player chrome and theater layout ([Player steps 1–2](user-interface.md#player-roadmap)) | Each step's checklist is complete. Write the new player in TypeScript (this replaces converting the old `player.js` first) and fold in item 4's findings. |
| 6 | **P2** | Playback performance graph ([Player step 3](user-interface.md#3-playback-performance-graph)) | The full checklist, including the new `fps` and `cpu` session fields. |
| 7 | **P2** | Remaining UI cleanup and discovery friction (done 2026-10-18 outside the Player) | The [cleanup todo](user-interface.md#cleanup-todo) P2–P4 items in order; intentional filter history/Back behaviour, visible local retries, selected genres outside the top chips, useful source errors without hover-only explanations, honest title-list truncation. Avoid unrelated page migrations. |
| 8 | **P2** | Finish boundary/error hardening | Validate remaining ports/timeouts/cache settings; bound indexer bodies and redirect policy; keep secrets out of logs. Upstream response shapes and URL schemes are covered by item 3's Phase 3 parse functions. |
| 9 | **P2** | Observe long-session cache/shutdown behaviour | After item 3: TTL/size limits for probe/subtitle memory if warranted, readiness/diagnostics useful for troubleshooting, and targeted shutdown tests built on the package factories. Record NAS numbers here if a limit ever needs tuning. |
| 10 | **P3 / on touch** | The rest of the TypeScript conversion | The other client pages, tests and scripts become `.ts` when they are next changed for another reason. There is no dedicated sweep. The plan's Phase 7 review runs once item 3 is done. |
| 11 | **P3 / conditional** | Interface translation ([i18n plan](plans/i18n-support.md)) | Not scheduled. Start only if a second interface language is actually wanted, and then with the smallest version: `Intl.PluralRules` plus one catalog. Catalog tooling and AI translation wait until there is more than one language to maintain. |
| 12 | **P3 / conditional** | Fingerprinted client assets | Add content hashes and immutable caching only if revalidating unversioned bundles becomes a measured problem. Preserve multi-page URLs, Node-only deployment and media cache/range semantics, and test the production artifact. |
| 13 | **P3 / conditional** | Browser remux or cross-origin hosting | Prototype only for a demonstrated NAS CPU/compatibility or deployment need. Measure seeking, memory and fallback behaviour first. General browser video transcoding is not planned. |

### Why this order

- **The product goal is met on the real deployment.** The owner confirmed on 2026-10-17 that playback on the NAS works without problems. Measuring it is no longer a gate, so the instrumentation that was pulled forward for that run goes back into the performance graph (item 6).
- **Known bugs before structure.** The five broken-behaviour items are small CSS and state fixes that a user hits today. They should not wait behind a reorganization.
- **Only the refactor's payoff phases are scheduled.** Phases 3–4 give the server typed upstream parsing, factories, `close()` and graceful shutdown, which items 8 and 9 build on. Converting the remaining client pages, tests and scripts mostly changes syntax. Doing it on touch costs nothing extra, while a sweep would conflict with items 5–7, which rewrite the same files.
- **Don't convert code that is about to be replaced.** Item 5 rewrites most of `player.js`. Converting it first and then rewriting it is double work.
- **Device findings before the redesign.** Item 4 is a short check on the devices actually used, so the chrome redesign in item 5 fixes real problems (fullscreen reaching audio and subtitles, for example) rather than guessed ones.

**Do not automatically schedule a playback-controller extraction, accounts or a framework migration.** These are conditional scope changes, not missing product features. Item 5 reshapes the player's chrome, not its lifecycle ([lifetime rules](lifecycle.md)). Phases 3–4 are the scheduled structural work, and they must not change behaviour.

Before public/untrusted exposure, authentication, media/API access protection and Origin/CSRF handling become mandatory deployment gates. They are intentionally not account features on the local-only roadmap.

## Boundaries to preserve

- `/raw` remains the single source of torrent bytes for direct playback, downloads, external players and ffmpeg/ffprobe. Keep Range, validators and cancellation consistent with `/tar`.
- Node owns indexer secrets, torrent discovery/cache, probing and server conversion. Static pages consume API/media contracts; a UI framework should not acquire those responsibilities.
- Same-origin Nginx static offload is already possible and does not imply CORS, accounts or a separate-origin client. Respect origin headers and avoid buffering live media.
- Maintain colocated fast tests and separate `tests/integration/` / `tests/e2e/` suites. Keep fixtures/tests out of production static/Docker artifacts.
- Keep policy/codec/timestamp helpers small and testable. Package boundaries follow [architecture.md](architecture.md) and are enforced by lint; within a package, prefer direct, local fixes over abstraction for its own sake.
