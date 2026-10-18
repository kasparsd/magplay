# Architecture

## Decision

magplay stays a small Node service with multi-page browser clients for one person on a trusted LAN, without accounts. [The roadmap](roadmap.md) owns priorities and completion status.

**Direction change (2026-10-17):** the code is reorganized into isolated packages and moved to strict TypeScript now, while the codebase is small (~5k lines) and the change is cheap. The server and packages are converted as scheduled work; client pages, tests and scripts convert when next touched ([roadmap](roadmap.md#why-this-order)). This replaces the earlier stance of deferring a TypeScript migration and factory refactors until a concrete bug required them. Reasons:

- Treating each area as if it were a standalone package exposed coupling that makes every fix and test harder: HTTP status codes thrown from the torrent/media/session logic, a global config imported for errors, configuration depending on indexer adapters, work done at import time, and modules that each hold several jobs (see Findings).
- The browser↔server API and the codec keys shared by the capability probe and the playback decision are only aligned by JSDoc and comments. Shared types make mismatches compile errors.
- Explicit factories with `close()` give tests and shutdown one owner per process, timer, port and directory, instead of module-level state.

Packages are internal npm workspaces. Publishing any of them is a later, optional step, not a goal. The work is tracked in [the package boundaries and TypeScript plan](plans/package-boundaries-and-typescript.md).

## Findings that motivated the change

All resolved by Phases 2–4 of the plan (2026-10-18); kept as the record of why.

| Problem | Where it was | Resolution |
| --- | --- | --- |
| HTTP concerns in core logic | `HttpError(503/504/499)` thrown from `torrents`, `media`, `sessions`, `limits`, `torrent-ready`, `search`, `sources/links` | Packages throw typed errors; `toHttpError` in `apps/server/src/http/errors.ts` is the only place they become statuses and `Retry-After` |
| Config is a global singleton with the dependency inverted | `config.js` imported `sources/index.js` for env parsing | `apps/server/src/config.ts` parses all env, including source configs; `loadConfig(env)` returns an object the app passes down |
| Work at import time | WebTorrent client and ports in `torrents.js`; facet loading and ffmpeg checks in `server.js`; module-level maps and timers in `sessions.js` | Factories (`createTorrentEngine`, `createHlsSessions`, `createApp`) with `close()`; `main.ts` starts and stops them |
| Modules with several jobs | `torrents.js`, `sessions.js`, `server.js` | Engine, store and activity in `torrent-engine`; ffmpeg and the disk budget in `playback`; tab fencing, play, Explore, playlists and subtitles as app services; HTTP in `http/` |
| Content classification split across layers | `episodes.js` and `sources/release.js` | `release-info` owns file kinds, episodes and badges |
| Implicit cross-runtime contracts | Codec keys and response shapes aligned by comments | `api-contract` types the API handlers' responses and holds `CODEC_KEYS`, read by `decide()` and the client's capability probe |

## Package boundaries

Arrows show dependencies; nothing points back up, and no package imports an app.

```
apps/server ──► indexers ──────► release-info
     │      ──► torrent-engine ─► release-info
     │      ──► seekable-tar
     │      ──► playback ───────► api-contract (track, capability and session types; codec keys)
     │      ──► http-kit
     └──► api-contract ◄── apps/client
```

| Package | Responsibility | Takes in | Never knows about |
| --- | --- | --- | --- |
| `release-info` | Pure helpers: release badges, episode detection, file kinds, executable warning | Strings and file lists | Anything else |
| `indexers` | Torznab/Jackett/Prowlarr/BitMagnet adapters, normalized `Release`, parallel search with timeouts, deduplication, private link IDs | Source configs, `fetch` | Env vars, HTTP status codes |
| `torrent-engine` | `createTorrentEngine(options)`: add/get/status/recent torrents, metadata store, cache eviction, discovery/checking deadlines; files expose cancellable range reads | Cache dir, ports, DHT/LSD, trackers, limits | HTTP request/response objects |
| `seekable-tar` | PAX tar layout computed from file sizes, any byte range produced on demand | Sizes, a `read(range)` callback | Torrents, Node streams |
| `playback` | `probe(input)`, `decide(info, caps, policy, audio)`, ffmpeg arguments, subtitle→VTT, `createMediaTools` (probe cache, process limits), `createHlsSessions(options)` with the session limit, HLS disk budget and fps/CPU sampling | An input URL or path, policy, ffmpeg paths | Tabs, routes, the app's port |
| `http-kit` | Router, Range parsing, conditional caching, `serveFile`, JSON helpers | Requests/responses | Core logic; only apps use it |
| `api-contract` | Types for the server JSON API (replaces `api-types.js`), the codec keys, the settings schema with `validate()` and the status level helpers, which run on both sides | — | Node or DOM APIs |

Each package throws its own typed errors (busy, timeout, not found, cancelled, invalid input). `apps/server` maps them to HTTP statuses in one place.

### Apps

- **`apps/server`**
  - `config.ts`: all env parsing, including indexer configs, validated once. `loadConfig(env)` returns the settings store, `current()` (the configuration in use) and `onChange`.
  - `app.ts`: `createApp({ config })` creates the HLS sessions, media tools and torrent engine in that order, then the services and routes; `listen()`, `startupChecks()` and `close()`. Packages get live settings through `live()` options that read `config.current()`.
  - `main.ts`: the process: config, app, startup checks (sources, ffmpeg, Explore's counts), listening, and graceful shutdown on SIGTERM/SIGINT.
  - `services/`: play (probe → decide → direct URL or HLS session), tabs (one session per player tab, and fencing for closed tabs; "tab" is a browser concept), Explore (cache, parameter checks), search (rebuilt when sources change; recognizes magnets before contacting sources, using torrent-engine parsing to return one release without fetching metadata), torrents (adding by private link id), playlists, subtitles, and the status registry and checks.
  - `http/`: routes typed against `api-contract`, request parsing from `unknown`, the error→status mapping, static and built-client serving, `/raw`/`/tar`, `/hls` and the speed test.
- **`apps/client`**: page entry points (search, explore, title, torrent, player, settings) and UI helpers. Imports API types and codec keys from `api-contract`.
- **`public/`**: static HTML and CSS only.

### Upstream requests and secrets

- Indexer adapters fetch through `request()` in `packages/indexers/src/release.ts`. It follows redirects itself, only on the same server (an http → https upgrade included) and at most three times, so an `X-Api-Key` header or `apikey=` query never reaches another host. A redirect elsewhere is a `SourceError` asking for the new address. Bodies go through `readBytes`/`readText`/`readJson`, capped at 16 MiB by `Content-Length` and while streaming.
- `redactSecrets()` in `api-contract` replaces API keys in query strings, URL passwords and `X-Api-Key` values. `captureConsole()` (`apps/server/src/logs.ts`) applies it to every console line before printing it and keeping it for Debug, and the client applies `redactDeep()` to copied diagnostics. Secret settings themselves leave the server only as `{ set }`.

### Settings and status

- **Schema.** `packages/api-contract/src/settings.ts` lists every setting once: key, section, scope (`server` or `browser`), control type, label, default and env vars. It holds only what a person tunes on the page; other knobs (ports, job limits, timeouts, trackers, ffmpeg paths) are env-only, resolved in `config.ts` (`envOnlyConfig`) with the same validation. The server validates env values, `settings.json` and `PATCH` bodies with the same `validate()` the client uses for `localStorage` and before saving. A new setting is one entry; the page, validation and API pick it up.
- **Server resolution.** `apps/server/src/settings-store.ts` resolves env, then `<CACHE_DIR>/settings.json`, then the default, records where each value came from, and writes the file atomically (temp file and rename). An invalid env value stops startup naming the variable; an invalid saved value is ignored with a warning. `loadConfig()` in `config.ts` combines the env-only knobs with the page's settings into one typed `Config`, replaced on the store's `changed` event, so a saved setting applies on its next use (packages read limits and paths through their `live()` options, search and Explore are rebuilt).
- **Status registry.** `apps/server/src/services/status.ts` holds checks (`id`, `label`, `ttl`, `required`, `run`), runs stale ones when `/api/status` is asked (waiting up to 4 s, then reporting `unknown`), and turns a throw into `error`. `services/status-checks.ts` registers the checks: one per source, Explore, ffmpeg/ffprobe and disk. The client merges browser checks (the connection test) and computes the overall level with the same `overallLevel()`.
- **Writes** (`PATCH /api/settings`, `POST /api/settings/test`, `POST /api/debug/clear-hls`) require `Sec-Fetch-Site: same-origin` or a matching `Origin` (`isSameOrigin` in `http-kit`), since there is no login.
- **Browser preferences** live in `localStorage`, one JSON value per setting under `magplay:<key with : for .>` (`magplay:player:speed`), the same keys the Player's `recall()`/`remember()` use. `apps/client/src/lib/preferences.ts` exports the keys (`PREFERENCE`, `STORAGE_KEYS`) and parses values against the schema on read.

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
