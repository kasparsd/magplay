# Vanilla client alternative to the React migration

Status: sketch for comparison, 2026-10-23. Not approved. Branch `claude/vanilla-client` ([PR #34](https://github.com/kasparsd/magplay/pull/34)), cut from `2220994` (the Vite build, before any React); Vite has since been replaced by one esbuild command. The React version to compare against is `codex/react-phase4` ([PR #33](https://github.com/kasparsd/magplay/pull/33), `0418ac9`). The [React plan](react-client.md) is still the approved one; this branch exists so the owner can choose with both in hand.

## Question

The React plan's diagnosis was correct: the Player kept state in module variables and in the DOM, and pages each had their own polling, staleness and URL code. Phase 1 of that plan, `PlaybackController`, fixed the Player's engine without React. This branch tests whether a few small primitives fix the rest just as well, with no framework.

## What this branch adds

- `lib/resource.ts` (165 lines, Node-tested):
  - `takeLatest()` starts a request and aborts the one before it, so a superseded fetch is cancelled, not just ignored. It replaces `latestRequest()` and the hand-written generation counters on these pages.
  - `createCache()` is a keyed cache with `staleMs`, requests shared while in flight, `peek` and `invalidate`. Storage is pluggable: a `Map`, or `sessionStorage` so Back to a page reuses its data.
  - `poll()` runs never more than one at a time, skips hidden tabs, catches up when the tab becomes visible, and takes a `when` condition, a minimum gap between runs and an abort signal.
- `lib/url-state.ts` (69 lines, Node-tested): a typed query-string schema with defaults and allowed values. Writes leave out defaults, and `push` or `replace` is chosen per write. `onChange` fires for Back and Forward.
- `lib/view.ts` (22 lines, Node-tested): `parts()`, the Player's `when(part, deps, draw)` redraw helper, shared so every page redraws the same way.

## What changed in the pages

- **Search** (`search.js` → `search.ts`): typed, uses `urlState` and `takeLatest`. The `sessionStorage` cache written by hand for Back is now `createCache(sessionStore())`. A new search, a category switch or a reload still always asks the sources.
- **Explore** (`explore.js` → `explore.ts`): typed, uses `urlState` for the filters and one `takeLatest` per request kind. The facet run counter is gone.
- **Torrent**: the `for (;;)` activity loop is now `poll(…, { everyMs: 2000 })`.
- **Status menu**: the interval, visibility, focus and 5-second-gap logic is now one `poll()` call.
- **Settings**: `setInterval` plus an on-screen check is now `poll(loadDebug, { when: () => onScreen.size > 0 })`.
- **Player**: uses `parts()`. Whether Details, Performance and the keys sheet are open now lives in a `ui` object that is written to the DOM and never read back from it.

## Build: esbuild, no Vite

Vite came in for React: the JSX plugin, one shell and a dev server for in-app navigation. Separate pages need none of that, and esbuild already split the lazy hls.js and mediabunny imports. `npm run build` is one esbuild command again. Page scripts and the stylesheet keep their names (`/assets/search.js`, `/assets/style.css`), so the HTML in `apps/client` links them as written and the server serves it unchanged. Neither the build nor the server rewrites links, as the server did before Vite. The chunks they import keep content hashes and stay immutable; entries revalidate with a content ETag, usually a 304. Page routes live only in the server, with no dev-server route list mirroring them. `package-lock.json` is identical to the one from before Vite.

## Review fixes from PR #33

PR #33's review regressions are ported unchanged as `tests/e2e/review.test.js`, so both branches are held to the same behaviour. Six already passed here, because separate pages never had those bugs: facets stay during refresh, retry shows progress on four pages, and fullscreen wakes the controls. The other six needed fixes:

- **Return context after playback and Next**: `returnTarget()` in `lib/back.ts` remembers, per tab, the catalog page that Torrent and Title were opened from. Coming back from the Player still links to Results, the title or the filtered Explore, by URL rather than Back.
- **Settings during a save**: every control and Discard are locked until the PATCH answers, and a read in flight is cancelled.
- **Settings on return to the tab**: changes made elsewhere show in unedited fields. Drafts and the focused field are left alone, and Discard returns to the new values.
- **Cached searches**: saving sources or the search timeout clears them, because private download-link ids change.
- **Picture in picture**: the controller reports `pipAllowed`, and the menu follows it.
- **Search focus**: only the empty home page focuses the search box.

Not ported, because they fix problems separate pages don't have: the router-state return context, a mounted search input that keeps its node, recovery from a failed Player chunk load, and StrictMode double activation.

## Side by side

Line counts of page and view code. Shared pure modules are the same on both branches and left out: the controller, playback-flow, seek, naming, urls and the like.

| Area | Vanilla (this branch) | React (`codex/react-phase4`, `0418ac9`) |
| --- | --- | --- |
| Player view: `player.ts` + status view + performance + `player.html` / `Player.tsx` + `PlaybackFlow` + `Performance` | 769 | 1,276 |
| Settings: page + controls + HTML / page + `controls.tsx` + `SettingsReadout` | 831 | 1,006 |
| Catalog pages: Search, Explore, Torrent, Title (+ HTML) / the same + `Catalog.tsx` | 739 | 1,048 |
| Shell and shared UI: `ui`, status menu, back, resource, url-state, view / router, main, TopBar, StatusMenu, ui, status menu, back, query, Menu, CopyButton, Icon, shell | 706 | 577 |
| **Total** | **3,045** | **3,907** |
| Build config | the `build` script in `package.json` | `vite.config.js` (35 lines) and the plugin |
| `package-lock.json` | 5,095 lines | 6,190 lines |
| Runtime dependencies added | none | react, react-dom, @tanstack/react-router, @tanstack/react-query |

Both columns include the PR #33 review fixes.

## What each approach gives

| Concern | Vanilla + primitives | React + TanStack |
| --- | --- | --- |
| Staleness of server data | `takeLatest()` aborts, and the caller checks `signal.aborted` after awaiting | Query keys |
| Polling | `poll()`: visibility, `when`, minimum gap, no overlapping runs | `refetchInterval`, `enabled` |
| Back shows earlier results | `sessionStore` cache plus BFCache | in-memory cache across in-app navigation |
| URL state | `urlState(schema)` | `validateSearch`, `navigate` |
| Teardown | a page unload ends everything | each component's effect cleanup, plus `pagehide` for the Player |
| Preserving focus and open menus | redraw only the parts whose values changed (`parts()`) | DOM diffing |
| Build and dev loop | one esbuild command; `--watch` plus `node --watch`, reload by hand | Vite build; dev server with hot reload and a proxy to Node |
| Agent feedback loop | the primitives and view models are tested in Node, in milliseconds | hooks and components have only Playwright (about 4 min) |
| Familiarity to agents | repo-specific helpers; this doc and their comments explain them | the most common idiom there is, but on library versions newer than most training data |

## Not done in this sketch

- Settings drafts still use the `errorSlots`/`readouts` partial-update maps. The next step would be a per-section `parts()`, so inputs stay mounted.
- Title still parses its params by hand. It would move to `urlState` and `createCache` like Search.
- No lint rule yet bans module-level `let` in page files or reading UI state back from the DOM. Both would be cheap to add and would steer agents.
- No devices, Safari or BFCache checks were run beyond the browser suite and the local Docker check.

## Log

- 2026-10-23: Sketched on `2220994`. Typecheck and lint pass; `npm run test:all` passed (334 Node, 4 peer, 80 Chromium tests, browser suite 3.1 min).
- 2026-10-23: Ported PR #33's review regressions and fixes; `npm run test:all` passed (336 Node, 4 peer, 92 Chromium tests).
- 2026-10-23: Replaced Vite with one esbuild command and stable entry names, so no build script or link rewriting is needed. `npm run test:all` passed (336 Node, 4 peer, 92 Chromium tests). Docker check not run.
- 2026-10-23: `tools/scripts/check-docker.mjs magplay:vanilla-check` passed on the esbuild build (local linux/arm64, full image with ffmpeg). Health and non-root runtime, revalidated entries and immutable hashed chunks, test-free image, cached torrent probe and byte ranges, direct MP4, AC3 remux with HLS from 0 and 30 s, session cleanup, metrics, logging and graceful shutdown. First remux segment 220 ms, from 30 s 186 ms; 112.5 MiB resident. Local Docker host only, not the server.
