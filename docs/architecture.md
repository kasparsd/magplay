# Architecture

## Decision

magplay stays a small Node service with multi-page browser clients for one person on a trusted LAN, without accounts. [The roadmap](roadmap.md) owns priorities and completion status.

**Direction change (2026-10-17):** the code is reorganized into isolated packages and moved to strict TypeScript now, while the codebase is small (~5k lines) and the change is cheap. The server and packages are converted as scheduled work; client pages, tests and scripts convert when next touched ([roadmap](roadmap.md#what-to-do-next)). This replaces the earlier stance of deferring a TypeScript migration and factory refactors until a concrete bug required them. Reasons:

- Treating each area as if it were a standalone package exposed coupling that makes every fix and test harder: HTTP status codes thrown from the torrent/media/session logic, a global config imported for errors, configuration depending on indexer adapters, work done at import time, and modules that each hold several jobs (now resolved by the package boundaries below).
- The browser↔server API and the codec keys shared by the capability probe and the playback decision are only aligned by JSDoc and comments. Shared types make mismatches compile errors.
- Explicit factories with `close()` give tests and shutdown one owner per process, timer, port and directory, instead of module-level state.

Packages are internal npm workspaces. Publishing any of them is a later, optional step, not a goal. The server/package extraction and tightening review are delivered. Remaining client and tooling conversions happen on touch and are tracked in [the package boundaries and TypeScript plan](plans/package-boundaries-and-typescript.md).

## Package boundaries

Arrows show domain dependencies; nothing points back up, and no package imports an app. Server packages also consume the shared observability interfaces (see [logging](logging.md)).

```
apps/server ──► indexers ──────► release-info
     │      ──► torrent-engine ─► release-info
     │      ──► seekable-tar
     │      ──► playback ───────► api-contract (track, capability and session types; codec keys)
     │      ──► http-kit
     │      ──► observability ─► api-contract
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
| `observability` | Structured logs, bounded Debug capture, metrics and runtime collectors | Logger/metrics options, lifecycle ownership | Domain operations and HTTP responses |
| `api-contract` | Types for the server JSON API (replaces `api-types.js`), the codec keys, the settings schema with `validate()` and the status level helpers, which run on both sides | — | Node or DOM APIs |

`@magplay/release` collects release notes and writes the application version and the root changelog. The server and the client do not import it.

Each package throws its own typed errors (busy, timeout, not found, cancelled, invalid input). `apps/server` maps them to HTTP statuses in one place.

Torrent detail requests use `torrent-engine.info()` to describe a ready torrent or read its saved `meta.torrent` directly. A cached file list does not activate WebTorrent, occupy an initialization slot, or wait for cached-piece verification; file indices and content warnings use the same description logic as active torrents. Missing or invalid saved metadata falls back to the normal discovery path. Playback and downloads still use `get()`/`file()` and wait for torrent readiness before reading bytes.

### Apps

- **`apps/server`**
  - `config.ts`: all env parsing, including indexer configs, validated once. `loadConfig(env)` returns the settings store, `current()` (the configuration in use) and `onChange`.
  - `app.ts`: `createApp({ config })` creates the HLS sessions, media tools and torrent engine in that order, then the services and routes; `listen()`, `startupChecks()` and `close()`. Packages get live settings through `live()` options that read `config.current()`.
  - `main.ts`: the process: config, app, startup checks (sources, ffmpeg, Explore's counts), listening, and graceful shutdown on SIGTERM/SIGINT.
  - `services/`: play (probe → decide → direct URL or HLS session), tabs (one session per player tab, and fencing for closed tabs; "tab" is a browser concept), Explore (cache, parameter checks), search (rebuilt when sources change; recognizes magnets before contacting sources, using torrent-engine parsing to return one release without fetching metadata), torrents (adding by private link id), playlists, subtitles, and the status registry and checks.
  - `http/`: routes typed against `api-contract`, request parsing from `unknown`, the error→status mapping, static and built-client serving, `/raw`/`/tar`, `/hls` and the speed test.
- **`apps/client`**: page entry points (search, explore, title, torrent, player, settings) and UI helpers. Imports API types and codec keys from `api-contract`.

- **`public/`**: static HTML and CSS only; the server links the pages to the hashed builds as it serves them.

The player's pure `lib/playback-status.ts` diagnoses the current wait; `lib/playback-flow.ts` presents it as four independently observed stages and an attributed wait location. It uses existing status and browser signals, exact selected-file completion, and published HLS readiness. `lib/playback-status-view.ts` retains nodes and controls across updates, including inspection, Diagnostics, focus, and common recovery menus. `player.ts` owns the page-local pin and retains a source-only snapshot for at most six seconds through session restarts; session and browser readiness do not survive those restarts. No new server endpoints or delivery-rate estimates support the flow. See [UI behavior](user-interface.md#playback-wait-explanations).

The torrent page is `apps/client/src/torrent.ts`, typed against the shared torrent/status contracts. It checks owned markup through `requireElement(selector, ctor)` and narrows browser history records before using them. Download-only primary actions use the existing `/raw?...download=1` or `/tar` routes; no eager torrent activation, new download job or second byte source is introduced.

### Upstream requests and secrets

- Indexer adapters fetch through `request()` in `packages/indexers/src/release.ts`. It follows redirects itself, only on the same server (an http → https upgrade included) and at most three times, so an `X-Api-Key` header or `apikey=` query never reaches another host. A redirect elsewhere is a `SourceError` asking for the new address. Bodies go through `readBytes`/`readText`/`readJson`, capped at 16 MiB by `Content-Length` and while streaming.
- Secret settings leave the server only as `{ set }`. [Logging and observability](logging.md) owns structured logging/redaction, metrics and collection architecture.

### `.local` source names

- mDNS multicast doesn't cross Docker's bridge network, so the container asks the host's avahi-daemon over its socket (`/run/avahi-daemon/socket`, mounted read-only from the host's `/run/avahi-daemon`).
- Resolution lives in the server (`apps/server/src/mdns.ts`), not in the image's libc. Alpine's musl has no NSS, so nss-mdns can't be used. A Debian base for `libnss-mdns` was tried and rejected: Debian's `ffmpeg` pulls in Mesa and LLVM, and the image grew from 457 MB to 987 MB.
- At startup, when the socket exists, `dns.lookup` is replaced by one that sends `.local` names to avahi (its `RESOLVE-HOSTNAME-IPV4/6` line protocol) and falls back to the original lookup for other names and failed answers. Node's `net`, and so `fetch`, reads `dns.lookup` on every connection; a unit test fetches through it so a Node change that breaks this shows up.
- ffmpeg only reads loopback `/raw` URLs, so it needs no mDNS. Resolution against a real avahi-daemon is still unverified (roadmap item 2).

### Settings and status

- **Schema.** `packages/api-contract/src/settings.ts` lists every setting once: key, section, scope (`server` or `browser`), control type, label, default and env vars. It holds only what a person tunes on the page; other knobs (ports, job limits, timeouts, trackers, ffmpeg paths) are env-only, resolved in `config.ts` (`envOnlyConfig`) with the same validation. Fields that accept an empty value are marked `optional`, shown on the page as "(optional)" by the label. The server validates env values, `settings.json` and `PATCH` bodies with the same `validate()` the client uses for `localStorage` and before saving. A new setting is one entry; the page, validation and API pick it up.
- **Settings presentation.** The schema declares presentation rules as a dependency key, an exact matching value, and overrides for visibility, disabled state, help or placeholder text. `apps/client/src/lib/setting-rules.ts` resolves them for both page settings and sibling fields in source items. Source guidance and URL examples follow the selected type, and Torznab omits the indexer filter. Hidden item fields retain their values across type changes. Conversion resolution follows the current draft toggle while preserving the chosen height; an environment lock always takes precedence. Source headings and Test button names follow URL edits in place using the hostname, without exposing URL credentials or replacing focused inputs. Debug resource polling replaces metric cells within stable disclosure elements, preserving expansion and keyboard focus.
- **Save confirmation.** A successful save records a four-second expiry deadline and schedules a refresh. New edits clear the confirmation and cancel its timer; a subsequent save replaces both. Rendering and page visibility/pageshow events check the deadline so delayed background timers cannot leave an expired confirmation visible. Browser tests advance a controlled clock for expiry, repeated saves and returning after a missed deadline.
- **Server resolution.** `apps/server/src/settings-store.ts` resolves env, then `<CACHE_DIR>/settings.json`, then the default, records where each value came from, and writes the file atomically (temp file and rename). An invalid env value stops startup naming the variable; an invalid saved value is ignored with a warning. `loadConfig()` in `config.ts` combines the env-only knobs with the page's settings into one typed `Config`, replaced on the store's `changed` event, so a saved setting applies on its next use (packages read limits and paths through their `live()` options, search and Explore are rebuilt).
- **Status registry.** `apps/server/src/services/status.ts` holds checks (`id`, `label`, `ttl`, `required`, `run`), runs stale ones when `/api/status` is asked (waiting up to 4 s, then reporting `unknown`), and turns a throw into `error`. `services/status-checks.ts` registers the checks: one per source, Explore, ffmpeg/ffprobe and disk. The client merges browser checks (the connection test) and computes the overall level with the same `overallLevel()`.
- **Writes** (`PATCH /api/settings`, `POST /api/settings/test`, `POST /api/debug/clear-hls`) require `Sec-Fetch-Site: same-origin` or a matching `Origin` (`isSameOrigin` in `http-kit`), since there is no login.
- **Browser preferences** live in `localStorage`, one JSON value per setting under `magplay:<key with : for .>` (`magplay:player:volume`), the same keys the Player's `recall()`/`remember()` use. Only volume and mute are in the schema (both `hidden`); the Player's other remembered choices — speed, audio and subtitle language — are its own keys, read raw with their own fallbacks, and have no Settings controls. `apps/client/src/lib/preferences.ts` exports the keys (`PREFERENCE`, `STORAGE_KEYS`) and parses values against the schema on read.

- **Where values live.** `settings.json` is in the folder `CACHE_DIR` names at startup (`./data` by default); the Cache folder setting moves torrent and HLS data, not the settings file, so startup never depends on a saved value to find its settings. Sources are items `{ id, type, url, apiKey, indexer }` (`indexer` is Jackett's indexer or filter, or Prowlarr's comma-separated ids; `apiKey` is optional — Jackett and Prowlarr need one, a plain Torznab feed usually doesn't); env items are locked and listed first. Secrets go out as `{ set }` and the browser sends `{ set: true }` back to keep one, matched by item id. Volume and mute are browser settings marked `hidden`: stored and validated, not shown on the page. GB settings are binary gigabytes (1024³).
- **Checks.** Every adapter has a cheap `check()` (Torznab `t=caps`, Prowlarr `/api/v1/health`, BitMagnet GraphQL `{ __typename }`). The status button's problem count includes warnings, so Explore without BitMagnet shows amber until its address is set.
- **Connection test.** Its controls and results are in the Debug section of Settings; connection status actions link to `/settings#debug`. `GET /api/speedtest` streams one reused 1 MB buffer of random bytes (defeating compressing proxies), honours backpressure, stops on `close` and caps at about 256 MB; it is `no-store` and counts against no session limit. `measureConnection()` in `apps/client/src/lib/speedtest.ts` takes the median of five `/health` fetches for latency, then reads one `/api/speedtest` response, skips the first ~1 s as warmup and stops at ~5 s. The result is stored per browser (`magplay:connection`) and feeds the `connection` client check: `warn` below 10 MB/s or above 100 ms, `unknown` if it never ran or is older than 7 days. It runs only on demand. The result card and status menu use the same warning helper to identify download speed below 10 MB/s, latency above 100 ms, or both; they do not infer a network cause.
- **Undecided:** whether env values should be importable into `settings.json`; whether a worsening level deserves a toast; whether the 30 s poll and 60 s source TTL suit rate-limited Prowlarr instances; whether the connection test should ever run unprompted; and the connection thresholds, pending real-server numbers (roadmap item 2).

### Rules

- Each workspace has its own `package.json` listing its dependencies and its own `tsconfig` with project references, so an undeclared import fails type checking. ESLint rejects imports of another package's internal files.
- Factories, not singletons: anything holding processes, timers, ports, sockets or directories is created by a factory and released by `close()`. No work at import time.
- Data from outside (indexer XML/JSON, BitMagnet GraphQL, ffprobe output, request bodies, `localStorage`) is `unknown` until a small parse function returns a typed value.
- A split must reduce coupling. Moving a large file into an equally coupled package is not progress.

## Build and tooling

TypeScript uses `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `noFallthroughCasesInSwitch`, `noUnusedLocals` and `noUnusedParameters` through the shared base configuration. `noPropertyAccessFromIndexSignature` stays off: bracket-only access added noise to intentionally dynamic env, schema, dataset and upstream records without finding a defect in the tightening review. Browser application and colocated test projects remain separate so Node globals do not leak into browser code.

The lint baseline is `recommendedTypeChecked`, plus exhaustive switches, consistent type imports, `restrict-plus-operands`, `no-unnecessary-type-conversion` and `use-unknown-in-catch-callback-variable`. The full strict/stylistic presets were evaluated; rules that rewrite safe numeric interpolation, void callbacks, collection syntax or defensive runtime checks are not enabled globally. Reconsider individual rules when a concrete failure warrants them, rather than maintaining hundreds of suppressions.

Assertions require a nearby invariant or a documented boundary: bounded indices into nonempty collections, successful pattern captures, schema-validated values, owned static markup and deliberately partial test doubles. The sole production double cast bridges Node fetch's async-iterable body and this project's DOM declarations in `indexers/release.ts`. Vendor declarations stay minimal in the consuming package; no explicit `any` is used. Inline lint suppressions must name a rule and explain the reason; the router's `@ts-expect-error` is a deliberate negative type test. The [Phase 7 checkpoint](checkpoints/2026-10-19-typescript-review.md) records the audit and validation.

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

## HLS session timing

An HLS session is one ffmpeg writing fMP4 segments from a point in the file (`ffmpegArgs` in `packages/playback/src/media.ts`). Its timestamps follow three rules, all for browsers' MSE parsers, which hls.js feeds the segments as they are:

- **A remux begins at the previous keyframe, and says so.** Copied video can only start on a keyframe. `keyframeBefore` reads that frame (one indexed lookup) and the session's `offset` is its time, not the later time the viewer asked for. `-ss` before `-i` seeks there, and `-noaccurate_seek` keeps converted audio from being trimmed to the request, which would put the tracks up to a GOP apart. The player then starts `request − offset` into the session, so the picture, the clock and the subtitles meet at the requested time. A transcode re-encodes, so it keeps an accurate seek and `offset` is the request. `-copyts` would also reveal the real timestamps, but it disables the timestamp repair that lets slightly irregular AAC copy into fragmented MP4, so the session stays zero-based and the origin is reported separately.
- **Start offsets live in `tfdt`, never in edit lists.** movenc writes every track's first fragment at decode time 0 and puts the track's real start (the audio/video gap, the B-frame reordering delay, AAC encoder priming) into an edit list in `init.mp4`. hls.js never reads edit lists and Chrome's MSE ignores empty edits, so audio ran ahead of video. `frag_discont` without edit lists keeps the offsets in `tfdt`; the outer hls muxer has already made the timestamps non-negative, so the fragment muxer must not shift again. Safari's native player accepts both forms.
- **Segment boundaries keep the source's presentation time.** The fMP4 muxer's DASH index rewrites an open GOP's first sample onto the previous segment's last timestamp, and Chrome drops one of the two frames that then share a time. HLS uses the playlist as its index, so `skip_sidx` omits that box and leaves the sample where the source put it. Copied video also keeps the container's timebase (`-copytb 1`): ffmpeg 6 otherwise derives the fMP4 timescale from the codec, rounds an MKV's millisecond timestamps into it, and movenc then judges a segment's opening keyframe out of range and writes it at its decode time.

The segment options are `use_editlist=0:movflags=+frag_discont+skip_sidx:avoid_negative_ts=disabled`. `tests/e2e/hls-sync.test.ts` measures a flash and a tone through the real argument list with edit lists ignored, and checks that an open-GOP remux presents exactly the source's frames, each at its own time. [The sync checkpoint](checkpoints/2026-10-19-hls-av-sync.md) and [the segment-timing checkpoint](checkpoints/2026-10-19-hls-segment-timing.md) record the measurements.

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
