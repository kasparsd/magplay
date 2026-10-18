# React client with TanStack

Status: evaluation, 2026-10-18. Not approved and not started. If approved, this replaces the "Preact is a conditional option" and "No SPA router" positions in [architecture](../architecture.md#framework-and-browser-media-triggers) and the "do not automatically schedule … a framework migration" line in [the roadmap](../roadmap.md#what-to-do-next). Update those documents in place when that happens.

## Verdict

Go, with one condition: the playback engine stays imperative, gets extracted into a plain TypeScript controller first, and React only renders its state. The trigger the architecture document set for a framework ("shared reactive state or component composition becomes the dominant maintenance problem") has been reached in the Player and Settings pages, and the client is still small enough (about 3,400 lines of page and helper code plus 520 lines of CSS) for the move to be cheap.

Stack: React + Vite, TanStack Router for URLs, TanStack Query for anything from the server, TanStack Form for Settings, and a small external store (TanStack Store or `useSyncExternalStore`) for the playback controller. No Redux, no global client-state library, no TanStack Start and no SSR.

## Why now: what is fragile today

The client is hand-written DOM code where every change has to re-render its dependants by hand and every async loop has to guard itself against being stale.

- **The Player** (`apps/client/src/player.ts`, 968 lines) has about 40 module-level `let` variables: decision, probe, status, phase, problem, pending position, generation, three AbortControllers, subtitle run counter, subtitle choice, drag state, idle timer, auto-mute and more. Changing one means remembering which renders to call: `setSpeed()` calls `renderSpeedMenu()`, `renderMore()` and `renderPlaybackStatus()` by hand.
- **Four overlapping staleness guards in one file:** `generation`, `playLife`/`subtitleLife` aborts, `subtitleRun`, and comparing `subsChoice` with the captured choice. Each async function re-checks some subset after every `await`.
- **The DOM is part of the state:** `$('#details').hidden` decides whether to render facts, `stage.classList.contains('idle')` is read back as state, and a speed toast is cleared by checking `$('#overlay .toast.notice')?.textContent?.startsWith('Speed')`. `notify(…, 'error')` also changes the playback phase as a side effect.
- **Menus are rebuilt with `fill()`** and then patched (`$('#subs-slot details') ?? …`) so an open menu doesn't close on a re-render.
- **Settings** (`settings.ts`) keeps `saved`, `draft`, `prefs`, `debug`, `status` and `tested`, plus `errorSlots` and `readouts` maps that exist only "so edits update in place without re-rendering (and losing focus)". The source list is re-rendered on a status poll only when nothing in it is focused or edited.
- **Five hand-rolled polling loops** with different rules: the Player's status (2 s, abortable), the Torrent page's activity (2 s, never stops, skips when hidden), the status menu (30 s, shares in-flight requests), Settings' debug readouts (5 s, only while visible through an IntersectionObserver), and the subtitle refresh (10 s).
- **URL state by hand:** `search.js` and `explore.js` use `pushState`/`replaceState`/`popstate`, and Search keeps its last results and scroll position in `sessionStorage` so Back shows them again. The Player reads its route with `location.pathname.split('/')`.
- `search.js`, `torrent.js`, `explore.js` and `title.js` are still JavaScript.

## What each piece replaces

| Concern | Today | With the new stack |
| --- | --- | --- |
| Server data (search, torrent, probe, status, settings, debug, explore) | `api()` + hand-written loops, `latestRequest()` guards, `sessionStorage` result cache | TanStack Query: query keys handle staleness, `refetchInterval` with background pausing handles polling, the cache makes Back instant, the `AbortSignal` goes to the existing `api()` |
| Writes (save settings, test source, clear HLS) | `fetch` + manual refresh of status and debug | `useMutation` + `invalidateQueries(['status'])`, `['debug']` |
| URL state (query, category, Explore filters, `ih`, `idx`) | `URLSearchParams`, `pushState`, `popstate` | TanStack Router: typed and validated `params`/`search` (`ih` checked as 40 hex characters in the route), `navigate({ search, replace })`, scroll restoration |
| Settings form (drafts, per-field errors, env locks) | `draft` object, `errorSlots` map, focus-preserving partial renders | TanStack Form with field validators calling `validate()` from `api-contract`; the save bar reads `form.state.isDirty` |
| Playback (hls.js, video element, sessions, tab fencing, subtitles, countdown) | Module-level variables in `player.ts` | A `PlaybackController` class in plain TypeScript with `subscribe`/`getSnapshot`; React subscribes and renders. No React inside it. |
| Local UI state (menus open, drag, tooltip, idle chrome, disclosures) | DOM classes and `hidden` read back as state | `useState` in the component that owns it |
| Shared top bar status | Re-mounted and refetched on every page load | One `['status']` query shared by the top bar and Settings across in-app navigation |

The TanStack recommendation for client state is to keep it local and lift it only as far as needed. Server state lives in Query and URL state in the Router, which leaves very little global client state here: browser preferences (already schema-validated in `lib/preferences.ts`) and the playback snapshot. Neither needs a store library beyond `useSyncExternalStore`; TanStack Store is fine if derived values get awkward.

## Options considered

| Option | Verdict |
| --- | --- |
| Stay vanilla, extract stores and a controller | Fixes the Player only partly; Settings, polling and URL handling stay hand-written. The controller extraction is part of the chosen plan anyway. |
| Preact + signals, pages stay separate | The architecture's earlier candidate. Smaller, but TanStack's adapters target React, and the desktop (Electron) and i18n plans gain more from mainstream React. Bundle size is not a constraint on a LAN app whose player already ships about 590 KB of hls.js. |
| **React SPA + TanStack Router + Query + Form, Vite** | **Chosen.** Keeps every URL, reload, Back and bookmark; adds instant in-app navigation and one shared cache. |
| TanStack Start | Rejected. It is a full-stack SSR framework; the Node server already owns the API, secrets and media, and SSR adds nothing for one user on a LAN. |
| React + Redux / Zustand | Rejected. Nearly all state is server or URL state, which Query and Router own. |

## Alignment with the project's direction

- **Invariants are untouched.** Node keeps indexer secrets, torrents, probing and conversion; `/raw` stays the single source of bytes; `api-contract` types stay the wire contract and are imported by the React code.
- **URL rules are kept in substance.** The old "no SPA router" rule protected `/`, `/explore`, `/title/…`, `/t/…` and `/play/…`, reload and Back. TanStack Router keeps all of them. The server keeps an explicit list of page routes and serves the one HTML shell for each, so unknown paths still return 404.
- **Caching contract is kept.** Vite writes content-hashed assets and a `manifest.json`; `apps/server/src/http/static.ts` reads that instead of esbuild's metafile. The shell stays `no-cache` with a content ETag, and `/assets/…` stays immutable. hls.js becomes a lazy chunk loaded only by the Player route.
- **TypeScript direction.** The remaining JS pages become TSX as they move, which completes the "convert on touch" rule.
- **Lifetime rules** in [lifecycle.md](../lifecycle.md) move into the controller unchanged: one AbortController per activation, per playback attempt and per subtitle selection; serialized play POSTs (`serialLatest`); tab fencing with `sendBeacon`. New: leaving the Player route inside the app is an unmount, not a `pagehide`, so `dispose()` must run on both and a route change to the next episode must close the tab's session exactly as a page load does.
- **Desktop (Electron, backburner)** fits better: one window navigating without reloads. Note for that plan: `localStorage` is per origin, so preferences won't survive a changed loopback port with or without React.
- **i18n (conditional)** should follow this work, never precede it, so strings are extracted once, from components. Pick an ICU-compatible React runtime then.
- **Roadmap P1 (device checks, real-server numbers)** is owner-side and not blocked. Run the Player device checks after the Player moves, so the evidence applies to the code that ships.

## Risks

- **Player regressions.** It is the most fragile and most tested area. Mitigation: extract the controller first, while the page is still vanilla and the 53 Chromium tests guard it; then move the view with the same element ids and accessible names so the tests keep working.
- **BFCache.** Tests dispatch synthetic `pagehide`/`pageshow`. The controller must keep handling those, plus unmount.
- **Two build systems for a while.** Vite can build the unmigrated pages as extra inputs, so there is one build throughout.
- **Lint.** Add `eslint-plugin-react-hooks` (rules of hooks, exhaustive deps) to the existing neostandard + typescript-eslint config; keep `--max-warnings 0`.
- **Tests.** Keep `node --test` for pure modules (the controller's logic included, with a fake video element) and Playwright for pages. No component test runner unless a need appears.
- **CSS** stays one global stylesheet with today's class names. Restyling or a CSS framework is out of scope.

## Plan

Each step is its own PR with a changeset, and `npm run test:all`, `typecheck` and `lint` pass at every step.

- [ ] **0. Decide.** Owner approves; update [architecture](../architecture.md) and [the roadmap](../roadmap.md) in place.
- [ ] **1. Playback controller, still vanilla.** Move everything except DOM rendering out of `player.ts` into `lib/playback-controller.ts`: hls.js, the video element, decisions, sessions, polling, subtitles, countdown, progress saves, tab id and fencing. It exposes `getSnapshot()`, `subscribe()`, commands (`play`, `seek`, `setAudio`, `setSubtitles`, `setSpeed`, …) and `dispose()`. The page becomes a renderer of snapshots. No behaviour change; useful on its own even if the rest stops here.
- [ ] **2. Foundation.** Vite + React + TanStack Router + Query; one HTML shell; server reads Vite's manifest and serves the shell for migrated routes and the old pages for the rest; Docker build stage, `npm run dev` with HMR, lint rules. Port the top bar and status menu (`['status']` query).
- [ ] **3. Search, Explore, Title.** Typed search params, Query for results and facets, Back without `sessionStorage`. Remove `latestRequest()` where Query replaces it.
- [ ] **4. Torrent.** Query for metadata (with the counting-seconds wait) and the 2 s activity poll; `link`/`magnet` params redirect to `/t/<infohash>` through the router.
- [ ] **5. Settings.** TanStack Form over the schema loop in `lib/controls.ts`; mutations for save and Test; debug readouts as a query enabled while the section is on screen.
- [ ] **6. Player view.** React components over the controller (`useSyncExternalStore`), lazy-loaded route, next episode through the router. Delete the vanilla page and the old HTML files.
- [ ] **7. Clean up.** Remove `ui.ts` DOM helpers nothing uses, the esbuild metafile code and old page routes; update the README's development and layout sections, `user-interface.md` and `lifecycle.md`.

## Log

- 2026-10-18: Evaluated against the code at `c2a7315`. Recommendation: React + TanStack (Router, Query, Form), controller-first, Player last.
