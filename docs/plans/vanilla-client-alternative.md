# Vanilla client alternative to the React migration

Status: sketch for comparison, 2026-10-23. Not approved. Branch `claude/vanilla-client`, cut from `2220994` (the Vite build, before any React). The React version to compare against is `codex/react-phase4` (`460b095`). The [React plan](react-client.md) is still the approved one; this branch exists so the owner can choose with both in hand.

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

## Side by side

Line counts of page and view code. Shared pure modules are the same on both branches and left out: the controller, playback-flow, seek, naming, urls and the like.

| Area | Vanilla (this branch) | React (`codex/react-phase4`) |
| --- | --- | --- |
| Player view: `player.ts` + status view + performance + `player.html` / `Player.tsx` + `PlaybackFlow` + `Performance` | 769 | 1,276 |
| Settings: page + controls + HTML / page + `controls.tsx` + `SettingsReadout` | 785 | 990 |
| Catalog pages: Search, Explore, Torrent, Title (+ HTML) / the same + `Catalog.tsx` | 733 | 1,024 |
| Shell and shared UI: `ui`, status menu, resource, url-state, view / router, main, TopBar, StatusMenu, ui, query, Menu, CopyButton, Icon, shell | 641 | 550 |
| **Total** | **2,928** | **3,840** |
| Runtime dependencies added | none | react, react-dom, @tanstack/react-router, @tanstack/react-query |

The React branch also includes fixes and features from its PR review: an unsaved-draft navigation guard, catalog retry states, facets that stay visible while refreshing, and PiP restrictions. Some of its extra lines pay for those, not for React itself.

## What each approach gives

| Concern | Vanilla + primitives | React + TanStack |
| --- | --- | --- |
| Staleness of server data | `takeLatest()` aborts, and the caller checks `signal.aborted` after awaiting | Query keys |
| Polling | `poll()`: visibility, `when`, minimum gap, no overlapping runs | `refetchInterval`, `enabled` |
| Back shows earlier results | `sessionStore` cache plus BFCache | in-memory cache across in-app navigation |
| URL state | `urlState(schema)` | `validateSearch`, `navigate` |
| Teardown | a page unload ends everything | each component's effect cleanup, plus `pagehide` for the Player |
| Preserving focus and open menus | redraw only the parts whose values changed (`parts()`) | DOM diffing |
| Agent feedback loop | the primitives and view models are tested in Node, in milliseconds | hooks and components have only Playwright (about 4 min) |
| Familiarity to agents | repo-specific helpers; this doc and their comments explain them | the most common idiom there is, but on library versions newer than most training data |

## Not done in this sketch

- Settings drafts still use the `errorSlots`/`readouts` partial-update maps. The next step would be a per-section `parts()`, so inputs stay mounted.
- Title still parses its params by hand. It would move to `urlState` and `createCache` like Search.
- No lint rule yet bans module-level `let` in page files or reading UI state back from the DOM. Both would be cheap to add and would steer agents.
- No devices, Docker or BFCache checks were run beyond the existing browser suite.

## Log

- 2026-10-23: Sketched on `2220994`. Typecheck and lint pass; `npm run test:all` passed (334 Node, 4 peer, 80 Chromium tests, browser suite 3.1 min).
