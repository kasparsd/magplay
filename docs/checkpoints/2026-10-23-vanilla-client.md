# Vanilla client versus React, 2026-10-23

Evidence for the [client decision](../architecture.md#framework-and-browser-media-triggers). Two React clients with TanStack Router and Query were built: `claude/react-client` ([#32](https://github.com/kasparsd/magplay/pull/32)) and `codex/react-phase4` ([#33](https://github.com/kasparsd/magplay/pull/33), `0418ac9`). A vanilla alternative, `claude/vanilla-client` ([#34](https://github.com/kasparsd/magplay/pull/34)), was cut from `2220994` (the Vite build, before any React). #34 was merged; #32 and #33 were closed.

## Comparison

Line counts of page and view code, both with #33's review fixes. Shared pure modules (the controller, playback-flow, seek, naming, urls) are the same on both and left out.

| Area | Vanilla (#34) | React (#33, `0418ac9`) |
| --- | --- | --- |
| Player view | 769 | 1,276 |
| Settings | 831 | 1,006 |
| Catalog pages (Search, Explore, Torrent, Title) | 739 | 1,048 |
| Shell and shared UI | 706 | 577 |
| **Total** | **3,045** | **3,907** |
| Build config | the `build` script in `package.json` | `vite.config.js` and the React plugin |
| `package-lock.json` | 5,095 lines | 6,190 lines |
| Runtime dependencies added | none | react, react-dom, @tanstack/react-router, @tanstack/react-query |

| Concern | Vanilla | React |
| --- | --- | --- |
| Staleness of server data | `takeLatest()` aborts; callers check `signal.aborted` after awaiting | Query keys |
| Polling | `poll()` | `refetchInterval`, `enabled` |
| Back shows earlier results | `sessionStorage` cache plus BFCache | in-memory cache across in-app navigation |
| Teardown | page unload ends everything | effect cleanup, plus `pagehide` for the Player |
| Focus and open menus | `parts()` redraws only changed parts | DOM diffing |
| Dev loop | esbuild `--watch` and `node --watch`, reload by hand | Vite dev server with hot reload and a proxy |
| Tests of view logic | Node, in milliseconds | Playwright only (about 4 min) |

## Review regressions

#33's review regressions were ported unchanged as `tests/e2e/review.test.js`. Six passed on the vanilla branch as they were, because separate pages never had those bugs (facets kept during refresh, retry progress on four pages, fullscreen waking the controls). Six needed fixes: the return context after playback and Next (`returnTarget()` in `lib/back.ts`), Settings locked during a save, Settings picking up changes made in another tab, cached searches cleared when sources change, picture-in-picture following `pipAllowed`, and focusing the search box only on the empty home page. Router-state return context, a mounted search input, recovery from a failed Player chunk load and StrictMode double activation were not ported: separate pages don't have those problems.

## Validation

- Typecheck and lint passed. `npm run test:all`: 336 Node, 4 peer and 92 Chromium tests, on the esbuild build.
- `tools/scripts/check-docker.mjs magplay:vanilla-check` passed on local linux/arm64 (full image with ffmpeg): health and non-root runtime, revalidated entries and immutable hashed chunks, test-free image, cached torrent probe and byte ranges, direct MP4, AC3 remux with HLS from 0 and 30 s, session cleanup, metrics, logging and graceful shutdown. First remux segment 220 ms, from 30 s 186 ms; 112.5 MiB resident.
- Not checked: devices, Safari and real BFCache eligibility (roadmap item 1).
