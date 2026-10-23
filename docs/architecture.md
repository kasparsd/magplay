# Architecture

## Decision

magplay stays a small Node service with multi-page browser clients for one person on a trusted LAN, without accounts. [The roadmap](roadmap.md) owns priorities and completion status.

**Direction change (2026-10-17):** the code is reorganized into isolated packages and moved to strict TypeScript now, while the codebase is small (~5k lines) and the change is cheap. The server and packages are converted as scheduled work; client pages, tests and scripts convert when next touched ([roadmap](roadmap.md#what-to-do-next)). This replaces the earlier stance of deferring a TypeScript migration and factory refactors until a concrete bug required them. Reasons:

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
| `playback` | `probe(input)`, `decide(info, caps, policy, audio)`, `keyframeIndex(read, size)` (Matroska cues, MP4 sample tables), segment plans, ffmpeg arguments, subtitle→VTT, `createMediaTools` (probe and keyframe caches, process limits), `createHlsSessions(options)` with on-demand segments, the session limit, HLS disk budget and fps/CPU sampling | An input URL or path, policy, ffmpeg paths | Tabs, routes, the app's port |
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
- **`public/`**: static HTML and CSS only; the server links the pages to the hashed builds as it serves them.

### Upstream requests and secrets

- Indexer adapters fetch through `request()` in `packages/indexers/src/release.ts`. It follows redirects itself, only on the same server (an http → https upgrade included) and at most three times, so an `X-Api-Key` header or `apikey=` query never reaches another host. A redirect elsewhere is a `SourceError` asking for the new address. Bodies go through `readBytes`/`readText`/`readJson`, capped at 16 MiB by `Content-Length` and while streaming.
- Secret settings leave the server only as `{ set }`. [Logging and observability](logging.md) owns structured logging/redaction, metrics and collection architecture.

### `.local` source names

- mDNS multicast doesn't cross Docker's bridge network, so the container asks the host's avahi-daemon over its socket (`/run/avahi-daemon/socket`, mounted read-only from the host's `/run/avahi-daemon`).
- Resolution lives in the server (`apps/server/src/mdns.ts`), not in the image's libc. Alpine's musl has no NSS, so nss-mdns can't be used. A Debian base for `libnss-mdns` was tried and rejected: Debian's `ffmpeg` pulls in Mesa and LLVM, and the image grew from 457 MB to 987 MB.
- At startup, when the socket exists, `dns.lookup` is replaced by one that sends `.local` names to avahi (its `RESOLVE-HOSTNAME-IPV4/6` line protocol) and falls back to the original lookup for other names and failed answers. Node's `net`, and so `fetch`, reads `dns.lookup` on every connection; a unit test fetches through it so a Node change that breaks this shows up.
- ffmpeg only reads loopback `/raw` URLs, so it needs no mDNS. Resolution against a real avahi-daemon is still unverified (roadmap item 2).

### Settings and status

- **Schema.** `packages/api-contract/src/settings.ts` lists every setting once: key, section, scope (`server` or `browser`), control type, label, default and env vars. It holds only what a person tunes on the page; other knobs (ports, job limits, timeouts, trackers, ffmpeg paths) are env-only, resolved in `config.ts` (`envOnlyConfig`) with the same validation. The server validates env values, `settings.json` and `PATCH` bodies with the same `validate()` the client uses for `localStorage` and before saving. A new setting is one entry; the page, validation and API pick it up.
- **Server resolution.** `apps/server/src/settings-store.ts` resolves env, then `<CACHE_DIR>/settings.json`, then the default, records where each value came from, and writes the file atomically (temp file and rename). An invalid env value stops startup naming the variable; an invalid saved value is ignored with a warning. `loadConfig()` in `config.ts` combines the env-only knobs with the page's settings into one typed `Config`, replaced on the store's `changed` event, so a saved setting applies on its next use (packages read limits and paths through their `live()` options, search and Explore are rebuilt).
- **Status registry.** `apps/server/src/services/status.ts` holds checks (`id`, `label`, `ttl`, `required`, `run`), runs stale ones when `/api/status` is asked (waiting up to 4 s, then reporting `unknown`), and turns a throw into `error`. `services/status-checks.ts` registers the checks: one per source, Explore, ffmpeg/ffprobe and disk. The client merges browser checks (the connection test) and computes the overall level with the same `overallLevel()`.
- **Writes** (`PATCH /api/settings`, `POST /api/settings/test`, `POST /api/debug/clear-hls`) require `Sec-Fetch-Site: same-origin` or a matching `Origin` (`isSameOrigin` in `http-kit`), since there is no login.
- **Browser preferences** live in `localStorage`, one JSON value per setting under `magplay:<key with : for .>` (`magplay:player:speed`), the same keys the Player's `recall()`/`remember()` use. `apps/client/src/lib/preferences.ts` exports the keys (`PREFERENCE`, `STORAGE_KEYS`) and parses values against the schema on read.

- **Where values live.** `settings.json` is in the folder `CACHE_DIR` names at startup (`./data` by default); the Cache folder setting moves torrent and HLS data, not the settings file, so startup never depends on a saved value to find its settings. Sources are items `{ id, type, name, url, apiKey, indexer }` (`indexer` is Jackett's indexer or filter, or Prowlarr's comma-separated ids); env items are locked and listed first. Secrets go out as `{ set }` and the browser sends `{ set: true }` back to keep one, matched by item id. Volume and mute are browser settings marked `hidden`: stored and validated, not shown on the page. GB settings are binary gigabytes (1024³).
- **Checks.** Every adapter has a cheap `check()` (Torznab `t=caps`, Prowlarr `/api/v1/health`, BitMagnet GraphQL `{ __typename }`). The status button's problem count includes warnings, so Explore without BitMagnet shows amber until its address is set.
- **Connection test.** `GET /api/speedtest` streams one reused 1 MB buffer of random bytes (defeating compressing proxies), honours backpressure, stops on `close` and caps at about 256 MB; it is `no-store` and counts against no session limit. `measureConnection()` in `apps/client/src/lib/speedtest.ts` takes the median of five `/health` fetches for latency, then reads one `/api/speedtest` response, skips the first ~1 s as warmup and stops at ~5 s. The result is stored per browser (`magplay:connection`) and feeds the `connection` client check: `warn` below 10 MB/s or above 100 ms, `unknown` if it never ran or is older than 7 days. It runs only on demand.
- **Undecided:** whether env values should be importable into `settings.json`; whether a worsening level deserves a toast; whether the 30 s poll and 60 s source TTL suit rate-limited Prowlarr instances; whether the connection test should ever run unprompted; and the connection thresholds, pending real-server numbers (roadmap item 2).

### Rules

- Each workspace has its own `package.json` listing its dependencies and its own `tsconfig` with project references, so an undeclared import fails type checking. ESLint rejects imports of another package's internal files.
- Factories, not singletons: anything holding processes, timers, ports, sockets or directories is created by a factory and released by `close()`. No work at import time.
- Data from outside (indexer XML/JSON, BitMagnet GraphQL, ffprobe output, request bodies, `localStorage`) is `unknown` until a small parse function returns a typed value.
- A split must reduce coupling. Moving a large file into an equally coupled package is not progress.

### HLS streaming

Remux and transcode play from one HLS playlist per player session that covers the whole file, on the file's own timeline. The client never converts between a session time and a file time: `video.currentTime` is the position in the file, seeking is a normal seek, and subtitles and the seek bar use the same times. The server converts on demand. This replaced live-growing sessions that restarted from an offset on every seek (2026-10-23).

- **Segment plan.** Copied video must be cut on keyframes, and every ffmpeg run must cut the same segments wherever it starts. `keyframeIndex()` reads keyframe times from the file's own index with a few range requests on `/raw` (Matroska `Cues` through the `SeekHead`, or the MP4 video track's `stss`/`stts`/`ctts`/`elst`), and `keyframePlan()` groups them into segments of at least 6 s. A cue list that misses keyframes only makes segments longer. Transcoded video uses `fixedPlan()`: every 6 s, with ffmpeg forcing a keyframe on each boundary.
- **Runs.** One ffmpeg at a time per session writes fragmented MP4 to fd 3 with a fragment at every keyframe. The session splits the stream (`fragmentSplitter()`), reads each fragment's start from its `tfdt`, and publishes a planned segment once one run has covered it from its start to the next boundary. A segment request is answered from published segments, by waiting when the running ffmpeg will reach it within 30 s of media (one segment when transcoding), or by restarting ffmpeg there. ffmpeg pauses (SIGSTOP) 240 s ahead of the later of the player's position and the last segment asked for. Published segments stay until the HLS disk budget evicts the ones furthest from the player; only then are producers stopped.
- **Timestamps** (verified with ffmpeg 6.1; see [the checkpoint](checkpoints/2026-10-23-vod-playback.md)). A run that starts at file time `T` uses `-ss (T − start_time)` (left out when not positive, since `-ss` counts from the file's start time) and `-output_ts_offset (T + 10)`, so every run's media timestamps are the file's own plus 10 s and the muxer never shifts one run differently from another. `-movflags +frag_keyframe+empty_moov+default_base_moof+frag_discont+negative_cts_offsets -use_editlist 0` makes `tfdt` absolute and the init segment byte-identical across runs; without `frag_discont` and `negative_cts_offsets`, each run's `tfdt` starts at 0 and only an edit list (which hls.js ignores) holds its start.
- **Restarts.** Copied video restarts one indexed keyframe before the boundary (0.15 s past it, because ffmpeg's CLI moves an input seek about 0.13 s earlier when the video has B-frames), with `-noaccurate_seek`, and that warm-up output is dropped: the audio for a segment's first moments is stored before its keyframe, and starting exactly on the boundary left a 0.7 s audio hole. Transcoded video seeks exactly to the boundary. Where two runs' segments meet, video matches to the millisecond and audio overlaps by under one AAC frame.
- **Subtitles** from the same ffmpeg use `-output_ts_offset T`, so cues are on the file's timeline; `sub_N.vtt` returns every run's cues and the player skips ones it already has.
- **No index** (MPEG-TS, AVI, an MKV without cues, fragmented MP4) or no duration: one run from the start and a growing EVENT playlist (`growing` in the decision and status). The player can seek only as far as conversion has reached and jumps to a resume position once it gets there.
- If an index names a keyframe that isn't one, the segment is served from the fragment that covers its start (a small overlap the browser replaces) and `hls.plan.mismatch` is logged.

## Build and tooling

- **Server:** runs `.ts` directly with Node's built-in type stripping; no emit step. Only erasable TypeScript syntax is allowed (no `enum`, `namespace` or parameter properties).
- **Client:** TypeScript requires a browser build, so esbuild bundles each page entry and the stylesheet into gitignored `dist/client/assets/` as `[name]-[hash]` files with sourcemaps, plus a metafile (`dist/client/meta.json`). The server reads the metafile (again after each rebuild) and rewrites the pages' `/search.js`-style links to the hashed URLs. `hls.js` becomes an npm import instead of the `/vendor/hls.min.js` global. `tsc` does type checking only.
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
- Revalidate HTML (`no-cache` with a content ETag). Only content-hashed `/assets/…` files are `immutable`, so reverse proxies and browsers pick up a release on the next page revalidation. Preserve media Range/cancellation policies and non-cacheable live responses/errors.

Vite remains an option if a dev server or bundled browser-media/WASM dependencies become a need; the requirements above apply to it too. No build system makes decoding or server remuxing faster by itself.

## Desktop distribution direction

Desktop packaging is a backburner item, not implemented or scheduled. Electron is the selected shell, with the existing interface in a dedicated BrowserWindow, bundled FFmpeg/ffprobe and target-specific native torrent dependencies. Electron main/preload code stays in TypeScript; the backend retains indexer, torrent, settings and media responsibilities in a supervised utility process using Electron's Node runtime. A separately bundled Node child is the fallback only if the packaged native-dependency spike requires it. Headless Node/Docker remains a separate launch mode of the shared backend.

The window loads pages, APIs and media from one loopback HTTP origin after readiness. The renderer has Node integration disabled, context isolation and sandboxing enabled, and only a narrow validated preload bridge. Electron is preferred over Tauri's system webviews and a browser-only launcher for a controlled Chromium playback runtime and an established Node desktop stack; actual codecs and native modules still require packaged tests on every target. Desktop resources resolve independently of the checkout, application data uses writable user directories, and persisted client preferences must survive a changed loopback port. [The desktop packaging plan](plans/desktop-packaging.md) owns the release matrix, Forge packaging, implementation phases, process containment and acceptance criteria; [the roadmap](roadmap.md#backburner) owns its deferred priority.

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
