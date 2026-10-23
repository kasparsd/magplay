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

## PR #33 review follow-up

Catalog retries show their pending state immediately, Explore retains facet choices during refresh, and the header search input stays mounted without automatic focus. Router history state is the only source of catalog return context; unrelated document referrers no longer influence the search field or back links. The obsolete raw HTML module declaration is removed.

Fullscreen transitions reveal the Player controls and reset their idle timeout. PiP availability comes from the controller snapshot and respects the video restriction; the controller also guards the command. Release-selection links and external-player menu triggers carry their action attributes.

Eight added browser regressions cover delayed facets, retries on all four catalog pages, search node/focus/referrer behavior, fullscreen wake and PiP restrictions. Follow-up validation passed: typecheck, lint and `npm run test:all` (321 Node tests, 4 peer entries and 99 Chromium tests; browser suite 4.1 minutes). The earlier local Docker acceptance is unchanged; it was not repeated for these UI fixes. Published commits are retained; the review fixes use a sentence-style follow-up commit on the existing PR.

## Interactive browser pass

Used the Codex in-app browser against the built local app, with generated cached media and a temporary loopback proxy supplying synthetic Explore/Title data and delayed search/facet responses. No live indexer or owner deployment was used. Inspected 375×812 and 1100×800 layouts.

Observed Search → Torrent → Results preserving the query without focusing the search box; a delayed failed search retry immediately displaying “Searching…”; genre/year/quality choices remaining visible during delayed facet refresh; Title → Explore restoring the selected genre; and Settings declining navigation while retaining a draft, then discarding it back to the saved value.

Played decoded MP4 video, switched to the MKV episode, resumed after a reload, changed audio to Latvian, selected the sidecar subtitle, entered/exited fullscreen and returned to the torrent with its resume action updated. The tab’s warning/error log query returned no entries. This is local in-app browser evidence, not physical phone, TV or owner-server acceptance.

The pass exposed an additional bug: changing Explore filters dropped the remembered header search query. Filter navigation now carries the catalog query in Router state. Rechecked genre, year, quality and sort changes in the live browser: “Playback” remains in the header. Extended the catalog regression; typecheck, lint and all 11 focused catalog/review browser tests pass. The full 321/4/99 run above predates this one-line filter-state fix and was not repeated.

- [Phone playback](2026-10-23-react-client/manual-browser-phone.png)
- [Desktop playback](2026-10-23-react-client/manual-browser-desktop.png)
- [Explore query retention](2026-10-23-react-client/manual-browser-explore.png)

## Save concurrency, return context and Settings freshness

Confirmed all three P2 findings from the `c2526be` review still applied after the earlier UI follow-ups. Source editing and Discard now lock for the whole save request. Settings revalidates on entry/focus, reconciles its saved baseline and external list values, and preserves draft fields until Save or Discard. Cancelling in-flight reads around a save prevents an older read from replacing its saved response. Catalog history carries nested return context across playback and episode navigation; non-adjacent return links use their retained URL rather than history Back into the Player.

Four focused regressions pass: delayed-save locking and persisted source value; Search → Torrent → Player with link/keyboard Next → files → Results; Settings reentry plus refocus after an external client write while scalar/source drafts survive, then Discard adopts the latest baseline; and playback → files → Title → filtered Explore. Final validation passed: typecheck, lint, 321 Node tests, 4 peer entries and the complete 103-test Chromium suite (3.9 minutes). The new tests read their starting settings and restore changed keys after each case to avoid shared-fixture ordering effects. The existing 18-test Settings/state sequence also passes together.

Interactive in-app browser checks used a separate generated-media fixture with a four-second Settings PATCH delay. Observed disabled source fields/Add/Remove/Test and Discard while saving, an enabled saved source afterwards, Results retained after returning from playback, and search timeout 37 on reentry after saving it in a second browser tab. This is local browser evidence, not owner-device/server acceptance.

- [Results retained after playback](2026-10-23-react-client/manual-state-return.png)
- [Pending save](2026-10-23-react-client/manual-state-saving.png)
- [Refreshed value from another tab](2026-10-23-react-client/manual-state-refresh.png)
