# React client completion — 2026-10-23

Branch: `codex/react-phase4`, continuing `claude/react-client` from `7eb3531`. Phase 4 evidence is in [the catalog checkpoint](2026-10-23-react-catalog.md). Torrent phase 5 is commit `61aa022`; Settings phase 6 is `115d02e`. Lasting design decisions are in [architecture](../architecture.md), [browser lifetimes](../lifecycle.md), [HTTP caching](../http-caching.md) and [UI behavior](../user-interface.md).

## Validation

- Phase 5: typecheck, lint and `npm run test:all` passed (321 Node, 4 peer, 83 browser tests).
- Phase 6: typecheck, lint and `npm run test:all` passed (321 Node, 4 peer, 83 browser tests).
- Final phase: typecheck, lint and `npm run test:all` passed (321 Node, 4 peer entries, 91 browser tests; browser suite 4.0 minutes).
- All eight added React architecture checks passed together: one document across Search/Torrent/Player; deferred Player assets; session disposal on return and Next; malformed route rejection before playback; unsaved draft protection; reload recovery after a blocked lazy chunk; source-test responses bound to the tested values; discovery cache clearing when private-link mappings are rebuilt; same-origin Settings PATCH through Vite; StrictMode activation/disposal without uncaught errors or console errors.
- Existing direct/HLS/browser-remux, subtitle/audio, fullscreen, keyboard, seek, resume, countdown, wait-flow focus/geometry and Settings regression coverage is retained.
- Docker `magplay:react-client-check`: isolated local `linux/arm64`, full/ffmpeg image, built from final client source. Acceptance passed: non-root health, hashed/test-free assets, raw ranges/probe, direct decision, VOD HLS remux from zero and 30 seconds, session cleanup, metrics/log redaction and graceful shutdown. Local smoke timings: first remux segment 424 ms; start-at-30-seconds first segment 222 ms. These do not establish deployment performance.

## Visual evidence

Inspected generated fixture playback at 1100×800 and 375×812; controls, title actions and the video fit both viewports. The complete browser suite also covers 320 px widths, landscape/fullscreen, larger text and touch targets.

- [Desktop Player](2026-10-23-react-client/react-player-desktop.png)
- [Phone Player](2026-10-23-react-client/react-player-phone.png)

## Findings during implementation

- Query notifications can be delayed by suspended timers. The Settings editor updates its successful-save baseline synchronously; controlled-clock regressions verify expiry and subsequent edits.
- The installed Router lazy helper emitted a React development warning from conditional `use()`. React lazy/Suspense avoids it; the Vite test checks both uncaught errors and console errors. Development also exposed invalid paragraph/details nesting, corrected in the Torrent actions container.
- A shared runtime preload appears after splitting the Player chunk. Shell tests now verify one identical shell, one stylesheet, hashed preload assets and no eager Player/hls.js preload, rather than assuming exactly two asset URLs.
- Server source/timeout changes rebuild private-link ids. A browser regression proves that the next search uses refreshed results instead of a cached expired private link.

## Remaining acceptance

Safari/native HLS, real phones/TVs and the owner's server were not available in this local run. Those post-merge checks stay in roadmap items 1–2. Chromium viewport tests and local Docker are not substitutes. Cross-tab/server-restart discovery-cache revision tracking is a separate roadmap follow-up; local Settings saves are covered here.
