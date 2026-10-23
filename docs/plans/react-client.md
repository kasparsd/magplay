# React client with TanStack Router and Query

Status: approved for implementation, 2026-10-23. Evaluated on 2026-10-18 at `c2a7315` and re-checked against `main` at `1d7845b` (0.4.0, VOD HLS and browser remux). [Architecture](../architecture.md#framework-and-browser-media-triggers) and [the roadmap](../roadmap.md#what-to-do-next) record the decision; the rest of the canonical docs change as the code lands (phase 7).

## Decision

Move the client to a React single-page app built by Vite, with TanStack Router for URLs and TanStack Query for server data. The playback engine stays imperative: it is extracted into a plain TypeScript `PlaybackController` first, and React only renders its snapshots.

Stack, and nothing more: `react`, `react-dom`, `@tanstack/react-router` (code-based route tree, no codegen plugin), `@tanstack/react-query`, `vite`, `@vitejs/plugin-react`, `eslint-plugin-react-hooks`. Exact versions are the latest stable releases on the day of install, pinned and listed in [dependencies](../dependencies.md).

Not used: TanStack Form (one form, whose validation already lives in `api-contract`), TanStack Store, Redux or Zustand (state is server, URL, local or the controller snapshot, read with `useSyncExternalStore`), TanStack Start, SSR, a CSS framework, a component test runner.

## Why

The trigger the architecture set for a framework ("shared reactive state or component composition becomes the dominant maintenance problem") has been reached in the Player and Settings, and the client is still small: about 2,070 lines of page code, 2,360 lines of library code and 600 lines of CSS.

- **The Player** (`apps/client/src/player.ts`, 1,020 lines) has about 40 module-level `let`s and now three playback modes (direct, HLS, browser remux through mediabunny). Changing one value means remembering which renders to call: `setSpeed()` calls `renderSpeedMenu()`, `renderMore()` and `renderPlaybackStatus()` by hand.
- **Four overlapping staleness guards** in that file: `generation`, the `playLife`/`subtitleLife` aborts, `subtitleRun`, and comparing `subsChoice` with the captured choice, re-checked after every `await`.
- **The DOM is part of the state:** `$('#details').hidden` decides whether to render facts, the `idle` class is read back, and the speed toast is cleared by matching `#overlay .toast.notice` text against "Speed". `notify(…, 'error')` changes the playback phase as a side effect.
- **Menus are rebuilt with `fill()`** and then patched so an open menu does not close.
- **Settings** (`settings.ts`) keeps `saved`, `draft`, `prefs`, `debug`, `status` and `tested`, plus `errorSlots` and `readouts` maps that exist only to update in place without losing focus.
- **Five hand-rolled polling loops** with different rules: Player status, Torrent activity, the status menu (30 s, shared in-flight request), Settings debug readouts (only while visible, through an IntersectionObserver) and the subtitle refresh.
- **URL state by hand:** `search.js` and `explore.js` use `pushState`/`popstate`, Search keeps results and scroll in `sessionStorage` for Back, and the Player parses `location.pathname`. These two pages are the last JavaScript ones.

## What replaces what

| Concern | Today | After |
| --- | --- | --- |
| Server data (search, torrent, probe, status, settings, debug, explore, title) | `api()`, hand-written loops, `latestRequest()` guards, `sessionStorage` result cache | Query. Keys handle staleness, `refetchInterval` handles polling (paused in background tabs by default), the cache makes Back instant. `queryFn` passes Query's `signal` to the existing `api()`. |
| Writes (save settings, test a source, clear HLS) | `fetch`, then a manual refresh | `useMutation`, then `invalidateQueries` for `['status']` and `['debug']` |
| URL state (query, category, Explore filters, `ih`, `idx`) | `URLSearchParams`, `pushState`, `popstate` | Router: `validateSearch`/param parsing (`ih` is 40 hex characters, `idx` a non-negative integer, otherwise not found), `navigate({ search, replace })`, built-in scroll restoration |
| Settings form | `draft` object, `errorSlots`, focus-preserving partial renders | `useState` draft per section, errors from `validate()` in `api-contract`, dirty = draft differs from the saved query data. Inputs stay mounted, so focus survives re-renders without special code. |
| Playback (hls.js, browser remux, video element, sessions, tab fencing, subtitles, countdown, progress) | Module-level variables in `player.ts` | `PlaybackController` in plain TypeScript: `subscribe`, `getSnapshot`, commands, `dispose`. No React inside it. |
| Local UI state (open menus, drag, tooltip, idle chrome, disclosures) | DOM classes and `hidden` read back | `useState` in the component that owns it |
| Top bar status | Mounted and fetched on every page load | One `['status']` query shared by the top bar and Settings across in-app navigation |

## Fixed design decisions

- **One HTML shell.** `apps/client/index.html` is Vite's entry. The server keeps an explicit list of page routes (`/`, `/explore`, `/title/:type/:source/:id`, `/t/:ih?`, `/play/:ih/:idx`, `/settings`) and answers each with the built shell; any other path is still a 404 from the server. `/player.html` keeps its 301.
- **No manifest reading.** Vite rewrites the shell's script and stylesheet links at build time, so `static.ts` only reads `dist/client/index.html` (re-read per request, `no-cache`, content ETag as today) and serves `/assets/` immutable. The esbuild metafile and the link-rewriting regex go away. The `ASSET` pattern widens to Vite's hash alphabet (`[A-Za-z0-9_-]{8}`) and any asset type the build emits (check for `.wasm` from the mediabunny packages). `public/` moves into `apps/client/`; the runtime image copies only `dist/client`.
- **Lazy Player.** The Player route is a lazy route. hls.js loads with it; mediabunny and its codec packages stay behind the existing dynamic imports and load only in browser-remux mode. If Vite trips over mediabunny's Node `worker_threads` branch, alias it to an empty module for the browser build.
- **Routes and links.** A code-based route tree in `apps/client/src/router.tsx`. In-app links use the router's `Link`; downloads, `/raw`, `/tar`, `.m3u` and magnet links stay plain anchors.
- **Player lifetime.** The Player component is keyed by `ih` and `idx`, so the next episode disposes one controller and creates another. The controller is created in an effect, never during render. `suspend()` runs on `pagehide`: it saves progress, aborts the activation, closes the session with `sendBeacon` and `POST /api/play/tab/:tab`. `activate()` runs on mount and on a BFCache `pageshow`, with a new tab id after a suspend. `dispose()` is `suspend()` plus removing listeners and media-session handlers, and runs on unmount. React StrictMode's double mount in development is therefore harmless (one extra session opened and closed).
- **Query defaults.** `staleTime` 0 for status-like data, a few minutes for search, explore and title results; `retry` off for 4xx; errors render where today's pages render them. One `QueryClient`, no persistence.
- **Element ids and accessible names stay.** The Playwright suites (74 tests, about 48 on the Player) are the regression net; a test changes only when the behaviour it checks is intentionally different, and the commit says why.
- **CSS** stays one global stylesheet with today's class names, imported by the shell.
- **Dev loop.** `npm run dev` runs Vite's dev server (HMR) with a proxy for `/api`, `/raw`, `/tar`, `/hls`, `/subs` and playlists to the Node server under `node --watch`. Confirm that settings writes pass the same-origin check through the proxy. `npm run build` is `vite build`; tests and `npm start` use the built output.
- **Types and lint.** `jsx: react-jsx` in the client tsconfig; `tsc -b` stays the only type check. `eslint-plugin-react-hooks` (recommended rules) joins the flat config, still `--max-warnings 0`. Pure modules, the controller included, keep `node --test`.

## Invariants kept

- Node keeps indexer secrets, torrents, probing and conversion; `/raw` is the single source of bytes; `api-contract` types are the wire contract the components import.
- Every public URL, reload, Back and bookmark keeps working. Same-origin Nginx static offload still works: it serves `dist/client` and proxies the same paths.
- The [lifetime rules](../lifecycle.md) move into the controller unchanged: one AbortController per activation, per playback attempt and per subtitle selection; serialized play POSTs (`serialLatest`); tab fencing; countdown ownership.
- Nothing loads from another origin.

## Plan

One branch, `claude/react-client`, merged as one PR. Each phase ends in a commit where `npm run typecheck`, `npm run lint` and `npm run test:all` pass; moves, conversions and behaviour fixes stay in separate commits. Add release notes with `npm run release -- note`: an empty note for phases with no visible change, and one `--minor` note for the switch to in-app navigation.

- [x] **0. Decide.** Approved; architecture and roadmap updated.
- [x] **1. Playback controller, still vanilla.** Move everything except DOM rendering from `player.ts` into `lib/playback-controller.ts`: hls.js, browser remux, the video element's events, decisions, sessions, status polling, subtitles, countdown, progress saves, tab id and fencing. It exposes `getSnapshot()`, `subscribe()`, commands (`play`, `retry`, `seek`, `setAudio`, `setSubtitles`, `setSpeed`, `next`, …) and `dispose()`. Collapse the four staleness guards into the three AbortController lifetimes. `player.ts` renders snapshots. Unit tests with a fake video element and fake `api()`. No behaviour change. Done: `lib/playback-controller.ts` with `getSnapshot`/`subscribe`, commands and `activate`/`suspend`/`dispose`; overlays (resume, countdown, missing file, notices) are snapshot state instead of DOM; `recall`/`remember` moved to `lib/storage.ts` and the performance samples to `lib/perf-samples.ts` so the controller imports nothing that touches the DOM; hls.js now loads on demand like browser remux. `player.ts` redraws each part only when the snapshot values it shows change.
- [x] **2. Vite build, no React yet.** Replace esbuild with Vite (multi-page for the existing pages, temporarily), move `public/` into `apps/client/`, simplify `static.ts` to serve built HTML, update the Dockerfile build and runtime stages, `npm run dev` and the asset pattern. Prove hashed assets, immutable caching, the content ETag, lazy hls.js and mediabunny chunks, and run `tools/scripts/check-docker`. Done with Vite 8.3.4 (`vite.config.js` at the root, pages in `apps/client/*.html`, the stylesheet in `apps/client/src/style.css`); esbuild is gone. Vite's hashes are base64url, so the asset pattern is `[\w-]{8}`; the build emits no `.wasm` (mediabunny inlines its codecs into lazy chunks), and its Node-only `worker_threads` import becomes Vite's browser stub without config. The dev server maps app URLs to pages with a small middleware until phase 3's single shell. The Player page loads 57 KB of its own script; hls.js (574 KB) and the mediabunny chunks load on demand. The architecture, README and HTTP caching docs describe the new build already.
- [ ] **3. React shell.** React, Router and Query; the one `index.html` shell; the root layout with the top bar and status menu (`['status']` query); pages not yet migrated mount their existing vanilla code from the route component until replaced. Server routes now all answer with the shell.
- [ ] **4. Search, Explore, Title.** As TSX, with typed search params and queries; Back without `sessionStorage` (the header search box reads the `q` param). Remove `latestRequest()` where Query replaces it.
- [ ] **5. Torrent.** Metadata query with the counting wait, the activity poll as `refetchInterval`; `link`/`magnet` params redirect to `/t/<infohash>` with `replace`.
- [ ] **6. Settings.** Sections as components over the schema in `lib/controls.ts`, mutations for save and Test, debug readouts as a query enabled while the section is on screen.
- [ ] **7. Player view and clean-up.** Components over the controller through `useSyncExternalStore`, lazy route, next episode through the router. Delete the vanilla pages, the shell mounting shim, unused `ui.ts` helpers and old HTML. Update the canonical docs in place: [architecture](../architecture.md) (client build, static delivery, framework section), [HTTP caching](../http-caching.md), [lifecycle](../lifecycle.md), [user interface](../user-interface.md), [dependencies](../dependencies.md), the README's development and layout sections, the roadmap's delivered list, and the "vanilla JS" assumption in the [i18n plan](i18n-support.md). Record validation in `docs/checkpoints/` and delete this plan.

## Risks

- **Player regressions** are the main risk, so the controller is extracted while the vanilla page and its tests still guard it, and the view keeps the same ids.
- **BFCache and unmount** are two ways to leave; both call `dispose()`. Synthetic `pagehide`/`pageshow` tests keep running.
- **mediabunny under Vite** (WASM codec chunks, the Node worker branch) is checked in phase 2, before any React code depends on the build.
- **Mixed pages during phases 3–6** exist only on the branch; the shim that mounts vanilla code is deleted in phase 7.
- **Device evidence:** run the roadmap's Player device checks on the merged build, so the evidence covers the code that ships.

## Log

- 2026-10-18: Evaluated at `c2a7315`. Recommendation: React with TanStack Router, Query and Form; controller first, Player last.
- 2026-10-23: Re-checked on `1d7845b`. Facts refreshed (Title and Torrent are TypeScript now, browser remux added a third playback mode). Dropped TanStack Form and Store; replaced manifest reading with a Vite-built shell; added a build-only phase before React; fixed routing, lifetime, Query and dev-loop decisions; one branch and one PR. Approved for implementation.
- 2026-10-23: Phase 1 done on `claude/react-client`. Two e2e tests already failed on `main` after VOD HLS (#29): a stale `offset` assertion, and a growing playlist whose file has no probed duration (the seek slider's maximum was 0). Fixed in a separate commit.
- 2026-10-23: Phase 2 done: Vite build and dev server, server serves built pages, Docker check passed (linux/arm64, remux first segment 171 ms).
