# Architecture

## Decision

magplay stays a small Node service with multi-page browser clients for one person on a trusted LAN/NAS, without accounts. [The roadmap](roadmap.md) owns priorities and completion status.

**Direction change (2026-10-17):** the code is reorganized into isolated packages and moved to strict TypeScript now, while the codebase is small (~5k lines) and the change is cheap. The server and packages are converted as scheduled work; client pages, tests and scripts convert when next touched ([roadmap](roadmap.md#why-this-order)). This replaces the earlier stance of deferring a TypeScript migration and factory refactors until a concrete bug required them. Reasons:

- Treating each area as if it were a standalone package exposed coupling that makes every fix and test harder: HTTP status codes thrown from the torrent/media/session logic, a global config imported for errors, configuration depending on indexer adapters, work done at import time, and modules that each hold several jobs (see Findings).
- The browser↔server API and the codec keys shared by the capability probe and the playback decision are only aligned by JSDoc and comments. Shared types make mismatches compile errors.
- Explicit factories with `close()` give tests and shutdown one owner per process, timer, port and directory, instead of module-level state.

Packages are internal npm workspaces. Publishing any of them is a later, optional step, not a goal. The work is tracked in [the package boundaries and TypeScript plan](plans/package-boundaries-and-typescript.md).

## Findings that motivated the change

| Problem | Where | Consequence |
| --- | --- | --- |
| HTTP concerns in core logic | `HttpError(503/504/499)` thrown from `torrents`, `media`, `sessions`, `limits`, `torrent-ready`, `search`, `sources/links`; `retryAfter` set in `limits`. Mapping is now central (`toHttpError` in `apps/server/src/errors.ts`) and extracted packages throw typed errors; these modules switch as they move into packages | Core code decides HTTP responses and can't be used or tested without the HTTP vocabulary |
| Config is a global singleton with the dependency inverted | `config.js` imports `sources/index.js` for env parsing (it no longer exports the HTTP error helper) | Every module depends on process env; configuration depends on an adapter |
| Work at import time | WebTorrent client created and ports bound in `torrents.js`; facet loading and ffmpeg checks at the top of `server.js`; module-level maps in `sessions.js` | Nothing can be created twice, configured per test or shut down cleanly |
| Modules with several jobs | `torrents.js` (engine, metadata store, eviction, content warnings, HTTP serving); `sessions.js` (ffmpeg processes, HLS disk budget, tab fencing, HTTP); `server.js` (startup, Explore cache, play orchestration, playlists, subtitle jobs, routes) | Changes in one job touch unrelated code |
| Content classification split across layers | Resolved: `release-info` owns file kinds, episodes and badges | — |
| Implicit cross-runtime contracts | `api-contract` types the wire data, but only client JSDoc references it so far; codec keys in `apps/client/src/lib/capabilities.js` must match `decide()` in `media.js` | Mismatches surface at runtime |

## Package boundaries

Arrows show dependencies; nothing points back up, and no package imports an app.

```
apps/server ──► indexers ──────► release-info
     │      ──► torrent-engine ─► release-info
     │      ──► seekable-tar
     │      ──► playback
     │      ──► http-kit
     └──► api-contract ◄── apps/client ──► playback (codec keys and types only)
```

| Package | Responsibility | Takes in | Never knows about |
| --- | --- | --- | --- |
| `release-info` | Pure helpers: release badges, episode detection, file kinds, executable warning | Strings and file lists | Anything else |
| `indexers` | Torznab/Jackett/Prowlarr/BitMagnet adapters, normalized `Release`, parallel search with timeouts, deduplication, private link IDs | Source configs, `fetch` | Env vars, HTTP status codes |
| `torrent-engine` | `createTorrentEngine(options)`: add/get/status/recent torrents, metadata store, cache eviction, discovery/checking deadlines; files expose cancellable range reads | Cache dir, ports, DHT/LSD, trackers, limits | HTTP request/response objects |
| `seekable-tar` | PAX tar layout computed from file sizes, any byte range produced on demand | Sizes, a `read(range)` callback | Torrents, Node streams |
| `playback` | `probe(input)`, `decide(info, caps, policy)`, ffmpeg arguments, subtitle→VTT, `createHlsSessions(options)` with process limits and HLS disk budget, codec key list | An input URL or path, policy, ffmpeg paths | Tabs, routes, the app's port |
| `http-kit` | Router, Range parsing, conditional caching, `serveFile`, JSON helpers | Requests/responses | Core logic; only apps use it |
| `api-contract` | Types for the server JSON API (replaces `api-types.js`), plus the settings schema with `validate()` and the status level helpers, which run on both sides | — | Node or DOM APIs |

Each package throws its own typed errors (busy, timeout, not found, cancelled, invalid input). `apps/server` maps them to HTTP statuses in one place.

### Apps

- **`apps/server`**
  - `config.ts`: all env parsing, including indexer configs, validated once.
  - `main.ts`: creates the engine, indexers and HLS sessions in order, runs startup checks and owns graceful shutdown.
  - Services that coordinate packages: play (probe → decide → direct URL or HLS session, tab fencing), Explore (cache, parameter validation), playlists, subtitle jobs. Tab fencing stays here because "tab" is a browser concept.
  - `http/`: routes, request parsing from `unknown`, the error→status mapping, static and built-client serving.
- **`apps/client`**: page entry points (search, explore, title, torrent, player, settings) and UI helpers. Imports API types from `api-contract` and codec keys from `playback`.
- **`public/`**: static HTML and CSS only.

### Settings and status

- **Schema.** `packages/api-contract/src/settings.ts` lists every setting once: key, section, scope (`server` or `browser`), control type, label, default, env vars and whether it applies live or after a restart. The server validates env values, `settings.json` and `PATCH` bodies with the same `validate()` the client uses for `localStorage` and before saving. A new setting is one entry; the page, validation and API pick it up.
- **Server resolution.** `apps/server/src/settings-store.ts` resolves env, then `<CACHE_DIR>/settings.json`, then the default, records where each value came from, and writes the file atomically (temp file and rename). An invalid env value stops startup naming the variable; an invalid saved value is ignored with a warning. `config.js` derives the shape callers already used and updates it in place on the store's `changed` event, so live settings apply on the next use (limits are read per job, search and Explore are rebuilt); restart-only settings keep their startup value and raise the restart check.
- **Status registry.** `apps/server/src/status.ts` holds checks (`id`, `label`, `ttl`, `required`, `run`), runs stale ones when `/api/status` is asked (waiting up to 4 s, then reporting `unknown`), turns a throw into `error`, and keeps a 50-entry ring buffer of level changes and "Settings saved" events. `status-checks.js` registers the checks: one per source, Explore, ffmpeg/ffprobe, disk, restart needed. The client merges browser checks (the connection test) and computes the overall level with the same `overallLevel()`.
- **Writes** (`PATCH /api/settings`, `POST /api/settings/test`, `POST /api/debug/clear-hls`) require `Sec-Fetch-Site: same-origin` or a matching `Origin` (`isSameOrigin` in `http-kit`), since there is no login.
- **Browser preferences** live in `localStorage` under keys exported from `apps/client/src/lib/preferences.ts` (`STORAGE_KEYS`, `PREFERENCE`), parsed against the schema on read.

### Rules

- Each workspace has its own `package.json` listing its dependencies and its own `tsconfig` with project references, so an undeclared import fails type checking. ESLint rejects imports of another package's internal files.
- Factories, not singletons: anything holding processes, timers, ports, sockets or directories is created by a factory and released by `close()`. No work at import time.
- Data from outside (indexer XML/JSON, BitMagnet GraphQL, ffprobe output, request bodies, `localStorage`) is `unknown` until a small parse function returns a typed value.
- A split must reduce coupling. Moving a large file into an equally coupled package is not progress.

## Build and tooling

- **Server:** runs `.ts` directly with Node's built-in type stripping; no emit step. Only erasable TypeScript syntax is allowed (no `enum`, `namespace` or parameter properties).
- **Client:** TypeScript requires a browser build, so esbuild bundles each page entry into gitignored `dist/client/`, with sourcemaps. `hls.js` becomes an npm import instead of the `/vendor/hls.min.js` global. `tsc` does type checking only.
- **Node baseline:** 24 LTS.
- **Linting:** ESLint (latest major, pinned, flat config) with typescript-eslint type-aware rules and neostandard for style. neostandard matches the existing code style (no semicolons, space before function parentheses), so no separate formatter is needed. Lint covers:
  - correctness the compiler misses, mainly floating or misused promises in the abort/lifecycle code and exhaustive `switch` over discriminated unions;
  - type hygiene: `import type`, no explicit `any`, `@ts-expect-error` only with a reason;
  - package boundaries: imports go through a package's public entry, never its internal files, and Node built-ins are banned in `apps/client`, `api-contract` and `release-info`.

  `npm run lint` runs in CI next to `typecheck`.

Requirements for the client build, kept from the earlier Vite criteria:

- Preserve `/`, `/explore`, `/title/…`, `/t/…` and `/play/…`, ordinary links and reload/Back behavior. No SPA router or SSR.
- Keep sources and generated output separate; never write into `public/`.
- Update Node serving, Docker packaging and smoke tests together, and test the production artifact (deep links, `hls.js` loading, playback), not only a dev setup.
- Revalidate HTML. Use immutable caching only for content-hashed assets if fingerprinting is added later. Preserve media Range/cancellation policies and non-cacheable live responses/errors.

Vite remains an option if a dev server, fingerprinted assets or bundled browser-media/WASM dependencies become a need; the requirements above apply to it too. No build system makes decoding or server remuxing faster by itself.

## Static delivery

A frontend proxy is not a cross-origin client. Nginx can serve the static pages and built client and proxy `/api`, `/raw`, `/tar`, `/hls`, `/subs` and playlists under the same origin. This needs neither CORS nor authentication. Node-only serving stays supported.

## Framework and browser-media triggers

Preact is a conditional option, not a chosen destination. Consider it only if shared reactive state or component composition becomes the dominant maintenance problem. Keep the media controller imperative even if a framework eventually owns its surrounding shell. The player's lifecycle and abort ownership is described in [lifetime rules](lifecycle.md).

Browser remuxing is optional P3 work; see [the research notes](research/browser-client.md). It must demonstrate correct Range input, seeking, acceptable client memory/CPU and server fallback. Browsers can't reach ordinary TCP/UDP swarms, so browser torrenting still needs compatible peers or a bridge. Cross-origin hosting and general browser video transcoding are not current requirements.

## Invariants

- Node keeps indexer secrets, torrent discovery and cache, probing and server conversion. Static pages consume API and media contracts.
- `/raw` is the single source of torrent bytes for the browser, ffmpeg/ffprobe, downloads and external players; `/tar` shares its Range, validator and cancellation semantics. `playback` receives the `/raw` loopback URL as its input from the app.
- Wire contracts are TypeScript types in `api-contract`, backed by narrow runtime parsing at boundaries.
- Fast unit tests live next to the modules in each package. Cross-application tests live in `tests/integration/` and `tests/e2e/`. Docker and static artifacts exclude tests and fixtures.
- Run `npm run test:all` for meaningful media/lifecycle changes, and repeat the isolated Docker check (`tools/scripts/check-docker`) when packaging or runtime behavior changes.
- Commit coherent, verified steps; keep moves, type conversion and behavior fixes in separate commits.
