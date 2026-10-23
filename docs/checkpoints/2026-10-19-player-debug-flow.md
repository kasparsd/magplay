# Player debug flow design study — 2026-10-19

Delivered a [proposal](../research/player-debug-flow/proposal.md) and [interactive mock source](../research/player-debug-flow/mock.html), grounded in the owner's photographed sketch and the current playback-status renderer, diagnosis, styles, and API contract. The HEIC reference was converted locally with ImageMagick for inspection; it was not copied into the repository. No production code changed. An empty changeset records the documentation/design change. The open presentation choice and debug-pin scope are in the roadmap; canonical UI guidance links the proposal without adopting it.

## Validation

- Rendered the fragment with the visualization skill's sandbox wrapper and inspected Chromium screenshots in light and dark appearances.
- Exercised both layouts across all 12 scenarios at viewport widths 780, 560, 375, and 320 px. Actual fragment space is smaller because the preview wrapper has side margins.
- Passed 480 coordinate/inspection cases: unchanged stage height and flow, inspector, and action positions across scenarios; all four node selections per scenario; no horizontal root overflow at the four widths.
- Checked Diagnostics stays expanded across reason changes, automatic following resumes after manual selection, metric sample updates change the conversion value, and actual carousel navigation selects Pinned ribbon. No JavaScript runtime errors occurred in the main matrix.
- Initial checks found movement at intermediate and narrow widths. Removing vertical auto-centering and reserving more inspector space fixed it before the final matrix passed.
- `git diff --check` and `npm run changeset:check` passed. Application tests were not run because production code is unchanged.

Browser validation required Chromium outside the filesystem sandbox. Mock values are illustrative; this is neither a real-server performance measurement nor validation of implemented playback behavior. Fullscreen, short landscape, increased text size, reduced motion, and real-device behavior remain implementation acceptance work in the proposal. The mock intentionally represents unknown progress with a static full-width activity track.

## Screenshots

- [Flow panel, desktop](2026-10-19-player-debug-flow/flow-panel-desktop.png)
- [Flow panel, phone](2026-10-19-player-debug-flow/flow-panel-mobile.png)
- [Pinned ribbon, dark](2026-10-19-player-debug-flow/pinned-ribbon-dark.png)
