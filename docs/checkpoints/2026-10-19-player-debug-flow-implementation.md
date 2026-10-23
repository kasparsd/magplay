# Player debug flow implementation — 2026-10-19

Implemented the approved Flow panel in the production player. The [canonical UI specification](../user-interface.md#playback-wait-explanations) owns behavior; [architecture](../architecture.md#package-boundaries) describes module ownership. The original [proposal](../research/player-debug-flow/proposal.md) and [design checkpoint](2026-10-19-player-debug-flow.md) remain historical inputs.

## Delivered

- Four permanent stages (Torrent → Server → Prepare → Player), stable layout slots, a single inspector following the diagnosed wait, and manual stage selection. A check means ready to supply playback, not processing finished.
- Existing cautious wait diagnosis and recovery actions, with exact selected-file progress, explicit unknown work, conversion throughput, published seconds ahead, and browser buffer. No new server endpoint, fake delivery rate, preparation percentage, or ETA.
- Retained Diagnostics, selection, keyboard focus, common recovery controls, and external-player menus through reason changes and metric updates. Long error details are disclosed without expanding the heading.
- Page-local pin through the wait panel or More → Playback flow, observing healthy playback and intentional pause without changing video geometry. The phone pin uses a compact symbol/name row; selection details remain reachable in the bounded panel.
- Session/generation guards and source-only observations retained for at most six seconds through a restart. Prior-session published output cannot satisfy current readiness; expired upstream measurements lose their checks.
- Phone, short-landscape, fullscreen, touch, larger-text and reduced-motion handling, retaining the existing compact conversion-capacity advisory and historical Performance lanes.
- Canonical documentation, README guidance, roadmap completion, and a minor changeset.

## Validation

- `npm run typecheck`, `npm run lint`, `npm run changeset:check`, and `git diff --check` passed.
- `npm test` passed all **245 tests**, including seven new flow-model cases covering source/torrent completion, concurrent conversion readiness, direct/paused/throttled debug states, stale signals, old sessions, attributed/unattributed failures, and retained source observations during a seek.
- Verified **28 distinct player browser cases** across focused runs: 13 existing chrome/layout/Performance cases, 12 wait-flow cases, and three desktop/phone pin cases. The final wait-flow run passed 13 cases (including one desktop pin case); the final pin run passed all three pin widths. The complete browser suite now lists 69 cases; settings/discovery cases were not rerun for this player-only change.
- Wait-flow coordinate assertions covered 1100, 560, 375 and 320 px, checking flow, inspector and footer bounds across browser, source, conversion and failure reasons. Diagnostics and manual inspection persisted, and a focused disclosure survived every reason change. A long conversion-error string stayed within Diagnostics. Source completion used determinate values; unknown browser work exposed no `aria-valuenow`.
- Real generated media recovered after held playlists, missing sessions, status outages, and blocked autoplay. The external-player menu and its focused copy action survived a session-loss reason change. Pinned direct playback and intentional pause retained video dimensions and kept all four inspection targets visible at 1100, 375 and 320 px.
- Short-landscape fullscreen retained recovery actions and selected-stage diagnostics. Reduced motion disabled the spinner. Touch targets and horizontal containment passed at 125% panel zoom, and the normal phone reason remained visible before zooming.

Initial browser checks caught a readonly DOM property used during node construction; this was fixed before subsequent runs. Layout checks then found action-row growth at 320 px; a reserved two-column phone footer removed it. Inspection of the open-menu screenshot also caught an inherited light hover background, which now uses the overlay surface colors. Tests were rerun after the relevant fixes.

Browser checks and the complete unit suite required execution outside the sandbox for Chromium and local listener fixtures. The initial sandboxed unit run failed in existing network-dependent server/torrent tests; the authorized rerun passed. No public swarm or remote service was used. This validates Chromium with generated fixture media, not performance on the owner's server or real-device Safari/Firefox behavior; those remain the existing roadmap acceptance work.

## Screenshots

- [Desktop](2026-10-19-player-debug-flow-implementation/desktop.png)
- [Phone](2026-10-19-player-debug-flow-implementation/phone.png)
- [320 px phone](2026-10-19-player-debug-flow-implementation/narrow-phone.png)
- [Short-landscape fullscreen](2026-10-19-player-debug-flow-implementation/landscape-fullscreen.png)
- [125% panel zoom with touch](2026-10-19-player-debug-flow-implementation/large-text-touch.png)
