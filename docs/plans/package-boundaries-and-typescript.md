# Package boundaries and TypeScript

Status: **In progress (Phase 7 next; 5–6 on touch)** · Owner: unassigned · Last updated: 2026-10-18

The target structure, its reasons and its rules are canonical in [architecture.md](../architecture.md); priority and completion evidence are in [the roadmap](../roadmap.md). This plan tracks how we get there.

## Goal

Reorganize the code into isolated internal packages with one-way dependencies, in strict TypeScript under ESLint. Each file is converted and moved once.

**Scope (revised 2026-10-17, see [the roadmap](../roadmap.md#why-this-order)):** Phases 0–4 are scheduled work, because they carry the structural payoff: typed upstream parsing, factories with `close()`, graceful shutdown and a typed server. Phases 5–6 (client pages, tests, scripts, config) happen on touch: a file becomes `.ts` when it is next changed for another reason. The player is rewritten in TypeScript by the [Player roadmap](../user-interface.md#player-roadmap) rather than converted first. Phase 7's review runs once Phase 4 is done.

### Success criteria

- All first-party code lives in `packages/*`, `apps/*`, `tests/` and `tools/scripts/`. Everything in `packages/*` and `apps/server` is `.ts` (the scheduled criterion). Client pages, tests and scripts reach `.ts` on touch; until then `allowJs` stays on for `apps/client` and the root tooling, and `eslint.config.js` stays JavaScript (Decision 10).
- Packages follow the dependency graph in the architecture doc. Each declares its dependencies in its own `package.json`, and an undeclared import fails type checking.
- Core packages throw typed errors; only `apps/server` knows HTTP statuses.
- No work at import time. Every owner of processes, timers, ports or directories is created by a factory and released by `close()`. `apps/server/main.ts` runs startup and graceful shutdown.
- `api-contract` is shared by server handlers and the client; `public/lib/api-types.js` is gone. The client imports codec keys from `playback`.
- `npm run typecheck` passes with the strict options below, with no `any` outside documented third-party boundaries and no `@ts-ignore` (a `@ts-expect-error` with a reason is allowed at vendor boundaries).
- `npm run lint` passes with no warnings on all first-party code, including the type-aware rules and package-boundary rules below. Rule disables are inline, name the rule and give a reason.
- `npm test`, `npm run test:peers`, `npm run test:e2e` and the isolated Docker check pass locally and in CI.

### Non-goals

- No behavior changes. Real bugs the compiler or the restructure finds are fixed in their own commits.
- No schema-validation library; boundary parsing is hand-written (revisit after Phase 3).
- No publishing to npm, no asset fingerprinting, no UI framework.

## Baseline

- ~45 first-party modules, ~5k lines excluding fixtures and the lockfile. ESM, Node `>=22`, no build step, no `tsconfig`.
- Server in `src/` with colocated `*.test.js` run by `node --test`. Client in `public/*.js` and `public/lib/*` as unbundled modules; `hls.js` served from `node_modules` as a global.
- JSDoc typing in about a dozen files; nothing type-checks it.
- `fast-xml-parser` ships types. `webtorrent`, `parse-torrent`, `bittorrent-tracker`, `create-torrent` and `hls.js` need checking; WebTorrent 3 types are likely incomplete.
- No linter or formatter. The code follows `standard` style by convention (no semicolons, space before function parentheses), unchecked.
- CI: Node 22/24 matrix, unit and peer tests, `node --check`, separate Chromium playback job. Docker: `node:22-alpine` with a separate production-install stage (`deps`) and a runtime stage that adds ffmpeg (`54cd9df`).

## Technical decisions

Build and runtime choices are summarized in the architecture doc; details live here. Update in place if revisited.

1. **Server runs `.ts` via Node type stripping.** No `tsc` emit, `tsx` or `ts-node`. Use `erasableSyntaxOnly`, `allowImportingTsExtensions` with `noEmit`, and `verbatimModuleSyntax` (`import type`). Relative imports use `.ts` extensions.
2. **Node 24 baseline:** `engines: ">=24"`, Docker `node:24-alpine`, CI matrix `[24, 26]`. Check type-stripping warnings on the chosen minor in Phase 0.
3. **Workspace packages run from source.** Each package's `exports` points at its `src/index.ts`. Type stripping doesn't apply under `node_modules`, so Phase 0 must confirm that workspace symlinks resolve to their real paths (Node's default) and get stripped. Fallback if they don't: TypeScript `paths` plus relative imports, keeping the same boundaries.
4. **Type checking with project references:** `tsconfig.base.json` holds compiler options. Each package and app has a `tsconfig.json` with `composite` and references to its dependencies. Packages use Node types without DOM; `apps/client` uses DOM without Node types; `api-contract` and `release-info` use neither. `npm run typecheck` runs `tsc -b`. Project references need declaration output, so emit goes to a gitignored `.tsbuild/` inside each project, used only by the type checker. The base config sets `composite`, `include`, `rootDir` and the output paths once through `${configDir}`; a project's `tsconfig.json` names only its `types`/`lib` and references. The root `tsconfig.json` is a solution file (`files: []` plus references). `apps/client` is a solution too: `tsconfig.app.json` (DOM, no Node types, tests excluded) and `tsconfig.test.json` (colocated `*.test.ts` with DOM and Node types for `node:test`, referencing the app project), because Node's timer and global types must not leak into page code. ESLint's `projectService` finds both through the solution file.
5. **Strict options:** `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `noFallthroughCasesInSwitch`, `isolatedModules`, `module`/`moduleResolution: nodenext`, `target: es2023` (raise if Node 24 allows). Unconverted files are covered by `allowJs` with `checkJs: false` until their phase.
6. **Client build:** esbuild bundles one ESM file per page into `dist/client/` with sourcemaps; `hls.js` is imported from npm.
7. **Typed errors:** each package exports its error classes. A single `toHttpError(err)` in `apps/server/src/http/errors.ts` maps them to status codes and `Retry-After`. App services throw `HttpError(status, message, { retryAfter })` from the same file.
8. **Third-party types:** use bundled or `@types/*` when they match the installed major; otherwise minimal declarations in the consuming package's `src/types/<pkg>.d.ts`, covering only the API we use.
9. **Tests:** `node:test` from `.ts` sources and Playwright with native TypeScript. Unit tests stay next to their modules inside each package.
10. **Linting:** ESLint (latest major, pinned) with one root `eslint.config.js` (flat config, `defineConfig`) covering all workspaces. It stays JavaScript: ESLint 10 loads a TypeScript config only through `jiti` or an unstable flag, and the file holds no logic worth typing. Global ignores come from `.gitignore` (`resolveIgnoresFromGitignore`).
    - **Style:** neostandard with `ts: true`. It continues the existing `standard` style and handles formatting through its stylistic rules, so there is no Prettier.
    - **Types:** typescript-eslint `recommendedTypeChecked` using `projectService` (which already includes `no-floating-promises`, `no-misused-promises`, `no-explicit-any` and `ban-ts-comment` with `@ts-expect-error` allowed with a description), plus `switch-exhaustiveness-check` and `consistent-type-imports`. `node:test` calls are allowed as known-safe floating promises. Type-aware rules apply to `.ts` files only.
    - **Boundaries:** `no-restricted-imports` bans deep imports into another package (`@magplay/*/src/**`) and `node:*` built-ins in `apps/client`, `api-contract` and `release-info`. `apps/client` also may not import server-only packages.
    - **Severity:** everything is an error and CI runs with `--max-warnings 0`. Rules that are too noisy are left off rather than set to warn.
    - **Strictness:** `strictTypeChecked` rules (e.g. `no-unnecessary-condition`, `restrict-template-expressions`) are evaluated in Phase 7, not enabled up front.

## Target layout

```
packages/
  release-info/    episodes + badges + PROGRAM_EXT/contentWarning
  indexers/        sources/* + search
  torrent-engine/  torrents (engine, store, eviction) + torrent-ready + limits
  seekable-tar/    tar
  playback/        media + sessions (minus tab fencing) + client codec keys
  http-kit/        router + range + http-cache
  api-contract/    api-types
apps/
  server/          config, main, services (play, explore, playlists, subtitles), http/
  client/          public/*.js + public/lib/*
public/            html + css only
```

`limits.js` is a generic limiter. It stays private inside `torrent-engine` and `playback`; each copy throws that package's own busy error. Promote it to a shared package only if a third user appears.

## Roadmap

Each phase leaves `main` passing typecheck, unit, peer and e2e tests and the Docker build, and lands as its own PR or short series of commits. Within a phase: moves first (`git mv`, no content changes), then decoupling, then conversion, as separate commits.

### Phase 0: Tooling foundation

- [x] Bump the Node baseline: `engines`, Dockerfile, CI matrix, README requirements.
- [x] Add pinned dev dependencies: `typescript`, `@types/node` matching the baseline, `esbuild`, `eslint`, `typescript-eslint`, `neostandard`.
- [x] Add `eslint.config.js` with neostandard style rules for the existing `.js` and the type-aware rule set for `.ts`; add `lint` and `lint:fix` scripts. Confirm ESLint loads a TypeScript config on the Node baseline.
- [x] Run `lint:fix` over the existing JavaScript in a separate formatting-only commit and list that commit in `.git-blame-ignore-revs`. Fix remaining non-style findings in their own commits, or turn the rule off with a reason.
- [x] Add npm workspaces (`packages/*`, `apps/*`) and `tsconfig.base.json`; root `typecheck` (`tsc -b`) and `build` scripts; `dev` (esbuild `--watch` + `node --watch`).
- [x] Spike: a workspace package written in `.ts` imported by name from a `.js` app file runs under Node type stripping (Decision 3), `node --test` finds `.ts` tests by glob, and Playwright loads a `.ts` config.
- [x] Replace the CI `node --check` step with `npm run typecheck` and `npm run lint`; build the client before e2e.
- [x] Gitignore `dist/` and `.tsbuild/`.

### Phase 1: Apps skeleton and client build

- [x] `git mv src/* apps/server/src/` and `public/*.js` and `public/lib/*` into `apps/client/src/`, leaving HTML and CSS in `public/`. Update imports, scripts, test globs and Dockerfile `COPY`s. No content changes.
- [x] esbuild entry per page; update `public/*.html` script tags; the server serves `dist/client/`.
- [x] Import `hls.js` in the player; remove the `/vendor/hls.min.js` route and script tag.
- [x] Multi-stage Dockerfile: a `deps` stage installs production `node_modules` and the runtime stage copies them (`54cd9df`).
- [x] Add a build stage with dev dependencies that runs `npm run build`; the runtime stage also copies workspaces, `public/` and `dist/client/`.
- [x] Update `tools/scripts/check-docker.mjs` and the e2e fixture server for the new paths; run the Docker check.

### Phase 2: Contract and pure packages

- [x] `api-contract`: `api-types.js` → real types (discriminated `PlaybackDecision` union etc.); the client imports it; delete the JSDoc file. Client JSDoc references `import('@magplay/api-contract')` until its files are `.ts`; server handlers adopt it in Phase 4.
- [x] `release-info`: move `episodes` detection, badges and `PROGRAM_EXT`/`contentWarning` out of `sources/release.js` and `episodes.js`; `indexers` and the server import from it. Convert with tests.
- [x] `seekable-tar`: move `tar.js` and tests; replace `Buffer` with `Uint8Array` if cheap; convert. Kept `Buffer` (header writes use its string encoders). The range/`attachment` tests that lived in `tar.test.js` moved to `apps/server/src/range.test.js` and go to `http-kit` with `range.js`.
- [x] `http-kit`: move `router`, `range`, `http-cache` and tests; type route params from path patterns; convert. Routes are built with `route(methods, pattern, handler)`, whose handler gets `params` typed from the pattern (`'/raw/:ih/:name?'` → `{ ih: string, name?: string }`); `createRouter` takes those rows. The package throws `MalformedPathError` and `FileNotFoundError` instead of setting `status`.
- [x] Enable the package-boundary lint rules as soon as the first package exists. `no-restricted-imports` bans any subpath import of `@magplay/*` everywhere; Node built-ins (`node:*` and bare names) in `apps/client`, `api-contract` and `release-info` outside `*.test.*` files (tests run under `node:test`); and `http-kit`, `seekable-tar`, `indexers`, `torrent-engine` and `server` in `apps/client`, tests included.
- [x] Introduce `apps/server/src/errors.ts` (`toHttpError`) and stop exporting `httpError` from `config.js`; packages from here on throw typed errors. `httpError()` became the `HttpError` class; `sources/links.js` uses it too instead of ad-hoc `{ status: 502 }` objects. `toHttpError` maps `HttpError` and `http-kit`'s `MalformedPathError`/`FileNotFoundError`, and flags anything else as an unexpected 500 for the server to log.
- [x] Convert pure client helpers: `lib/urls`, `lib/requests`, `lib/subtitles`, `lib/progress`, `lib/api`, `lib/ui`. Their tests are `.ts` too; the page entries stay `.js` (Phase 5) and import the helpers with `.ts` extensions, which esbuild bundles as before. `api()` throws an `ApiError` class (still with `status`); `ui.ts` dropped its compatibility re-export of `api`; `$()` returns a non-null element typed by a generic until Phase 5's checked `requireElement`; `recall()` returns `unknown` and `resumePosition()` checks the stored record instead of trusting it. `capabilities` waits for Phase 5 with the `playback` codec keys.

### Phase 3: Indexers

- [x] Move `sources/*` and `search` into `indexers`; move `sourcesFromEnv`/`bitmagnetUrl` env parsing into `apps/server/config.ts`, so config no longer imports an adapter. `sourceConfigs` (settings items → configs) and `hostName` moved too; `config.ts` reads only the indexers' `SourceConfig` type and `SOURCE_TYPES`.
- [x] Replace `httpError` in `search` with indexer errors (`SearchTimeout`, `SourceError`, `LinkExpired`). Also `NoSourcesError` (the 503 for "no sources configured"). `search` throws `SourceError` naming each source when all fail; `linkFor(id)` throws `LinkExpired` instead of returning null; `resolveLink` throws `SourceError` instead of `HttpError(502)`; the BitMagnet browser turns a timeout into `SearchTimeout`, so the Explore cache no longer translates errors. `toHttpError` maps them to 502, 503, 504 and 410 as before.
- [x] Define a `Source` interface and the `Release` type in one place; parse functions for Torznab XML, Prowlarr JSON and BitMagnet GraphQL; fixtures exercise them. `parseTorznabFeed`/`parseTorznabCaps`, `parseProwlarrResults` and `parseSearchResponse` take `unknown` (or XML text) and return typed values; `createSource(config)` switches over a discriminated `SourceConfig` union.
- [x] Convert with tests; revisit the no-validation-library decision. Kept hand-written parsing: four small `as*` narrowing helpers in `release.ts` cover every upstream shape, and the parse functions read like the data they accept. A library would add a dependency and a second way to describe types without removing code.

### Phase 4: Torrent engine, playback and the server split

- [x] Types for `webtorrent` and `parse-torrent` covering the API we use. Local declarations in `packages/torrent-engine/src/types/` (DefinitelyTyped's `@types/webtorrent` describes v1/v2, whose file API has no async iterator; parse-torrent 11 ships none). They cover the client, torrent, file and wire fields `engine.ts` and `activity.ts` read, including the internal `_startPiece`/`_endPiece` the downloaded-ranges view needs.
- [x] `torrent-engine`: `createTorrentEngine(options)` with `close()`; move metadata store, eviction, deadlines (`torrent-ready`) and status; file handles expose cancellable range reads. Raw/tar HTTP serving moves to `apps/server/http/` using `http-kit` and `seekable-tar`. Options split into fixed ones (folder, port, DHT, LSD) and `live()`, read on each use for the load limit, trackers, timeouts, idle time and cache size. The engine returns its own `Torrent`/`TorrentFile` handles (`file.read(start, end, signal)`), counts streams through `openStream(ih)`, and throws `InvalidTorrentError`, `NoSuchFileError`, `TorrentTimeoutError`, `TorrentFailedError` and `EngineBusyError`. Download-link resolution moved to the app (`services/torrents.ts`), so the engine doesn't depend on `indexers`.
- [x] `playback`: `probe(input)`, `decide(info, caps, policy)`, `ffmpegArgs`, `subtitleToVtt`, `createHlsSessions(options)` with `close()`. `rawUrl` and the app port leave the package; the app passes the `/raw` loopback URL. Tab fencing and `serveHls` move to the app. Export codec keys; `apps/client` `capabilities` imports them. `decide` takes the requested audio track as a fourth argument; `parseProbe` turns ffprobe JSON (`unknown`) into `MediaInfo`; `createMediaTools({ live })` adds the probe cache and the probe/subtitle process limits. `createHlsSessions` takes `replaces` (the tab's previous session, which doesn't count against the limit) and `onStop`, and keeps the fps/cpu sampling (`readProcCpu`, `parseProcStat`, injectable `readCpu`/`cores`). **Changed:** the codec keys live in `api-contract` (`CODEC_KEYS`, `VIDEO_CODEC_KEYS`, `AUDIO_CODEC_KEYS`), not `playback`: `playback`'s entry imports `node:child_process`, which can't go into a browser bundle, and `CodecKey` was already a wire type. `playback` reads them from `api-contract`, and `capabilities.js` builds its answer from `CODEC_KEYS`. `capabilities` stays `.js` for now: `player.js` imports it by that path, and the player is being rewritten by the Player roadmap, so it converts with that rewrite.
- [x] Split `server.js`: `config.ts` (typed, validated once), `main.ts` (create packages, startup checks, facet warming, signal handling and `close()`), `services/` (play, explore, playlists, subtitles) and `http/` (routes, request parsing from `unknown`, `toHttpError`). `app.ts` holds `createApp({ config })` with `listen()`, `startupChecks()` and `close()`, so tests build the whole server in-process; `main.ts` only loads the config, creates the app, listens and handles SIGTERM/SIGINT (close, then exit, with a 10 s backstop). `services/` also holds search (rebuilt on settings changes), torrents (adding by link id), tabs, the status registry and its checks; `http/` holds routes, static pages, `/raw`/`/tar`, `/hls`, the speed test, request parsing and `errors.ts`. Live settings reach the packages through `config.current()` in their `live()` options; `config.onChange` rebuilds search and Explore and re-runs the affected status checks.
- [x] Tests construct packages with factories instead of relying on module state; add a graceful-shutdown test. `app.test.ts` starts the app in-process on port 0 (pages, errors, statuses, live settings, and `close()` ending an open stream and killing a paused ffmpeg); `main.test.ts` spawns `main.ts` for env errors and SIGTERM. Engine, HLS and tab tests each create their own instance in a temp folder.
- [x] Convert with tests; remove `allowJs` from the server and packages. `allowJs` now sits only in `apps/client`'s two configs.

### Phase 5: Client pages (on touch)

Not a dedicated sweep. Each page entry is converted the next time it changes substantively; `player.js` is replaced by the TypeScript rewrite in [Player step 1](../user-interface.md#1-one-player-chrome-for-every-mode). `capabilities` converts with Phase 4, when it starts importing codec keys from `playback`.

- [ ] Convert `capabilities`, then the `search`, `explore`, `title`, `torrent` and `player` entries as they are touched. The player keeps its imperative lifecycle ([lifetime rules](../lifecycle.md)); per-activation state objects are fine where they fall out naturally.
- [ ] Add a typed `requireElement(selector, ctor)` helper instead of non-null assertions, with the first page conversion.
- [ ] Remove `allowJs` from `apps/client` once the last page is converted.

### Phase 6: Tests, scripts and config files (on touch)

As Phase 5: convert a test or script when it is next changed. The closing items wait until nothing is left.

- [ ] `tests/e2e/*`, `tests/fixtures/*`, `tests/integration/*` (types for `bittorrent-tracker` and `create-torrent`).
- [ ] `tools/scripts/setup-indexers` and `tools/scripts/check-docker` → `.ts`; `playwright.config` → `.ts`.
- [ ] When nothing is left: remove `allowJs` everywhere and add a CI check that fails on first-party `.js`/`.mjs`.
- [ ] Widen the type-aware block in `eslint.config.js` from `**/*.ts` to every file.

### Phase 7: Tighten and document

Runs once Phase 4 is done, since Phase 4 adds most vendor-boundary types (`webtorrent`, `parse-torrent`). Its doc updates happen with each phase rather than at the end.

- [ ] Review every `any`, `as unknown as`, non-null `!` and `@ts-expect-error`; justify or remove each.
- [ ] Consider `noPropertyAccessFromIndexSignature` and `noUnusedLocals`/`noUnusedParameters`.
- [ ] Evaluate typescript-eslint `strictTypeChecked` and `stylisticTypeChecked`; enable the rules that find real issues without noise. Review every inline `eslint-disable`.
- [ ] Update `README.md` (layout, dev workflow, requirements), `DEPENDENCIES.md`, `docs/architecture.md` (mark delivered, remove the findings table if obsolete), the roadmap entry and the test READMEs.
- [ ] Mark the scheduled scope (Phases 0–4 and 7) complete. Phases 5–6 stay open until their last file converts.

## Progress tracker

| Phase | Scope | Status | PR / commit | Notes |
| --- | --- | --- | --- | --- |
| 0 | Tooling foundation | ✅ Done | `7b4b27b`, `6a9e2af`, `2152cad` | TypeScript pinned to 5.9.3, not 7 (typescript-eslint 8 peers `<6.1.0`); the ESLint config is `.js` (a `.ts` one needs `jiti`); npm 11.20 gates install scripts, allowed native ones via `allowScripts` in package.json |
| 1 | Apps skeleton and client build | ✅ Done | `54cd9df`, `6a9e2af` | esbuild `--minify --sourcemap`; URLs unchanged (`/search.js` etc. now served from `dist/client/`); `npm test` and `test:e2e` build first; hls.js moved to devDependencies (bundled at build time, never served); Docker check passed on Node 24 Alpine |
| 2 | Contract and pure packages | ✅ Done | `ee3ae1d`, `8c1b76c`…`00ef1de` | `api-contract`, `release-info`, `seekable-tar`, `http-kit`, boundary lint rules, `toHttpError` and the pure client helpers |
| 3 | Indexers | ✅ Done | `cd6c1bc` | `@magplay/indexers`; typed parse functions with fixtures; indexer errors; env parsing in `apps/server/src/config.ts` |
| 4 | Torrent engine, playback, server split | ✅ Done | `f171049`, `87b8beb`, server split commit | `torrent-engine` and `playback` with factories and `close()`; `apps/server` fully `.ts` with `app.ts`/`main.ts`, `services/`, `http/`; graceful shutdown tested |
| 5 | Client pages | ⬜ On touch | | Player rewritten in TS by Player step 1 |
| 6 | Tests, scripts, config files | ⬜ On touch | | |
| 7 | Tighten and document | ⬜ Not started | | After Phase 4 |

Legend: ⬜ Not started · 🟨 In progress · ✅ Done · ⛔ Blocked

### Package checklist

Tick when the package exists, has its own `package.json` and `tsconfig`, is fully `.ts`, type-checks, passes lint and its tests pass.

- [x] `api-contract` (from `api-types`)
- [x] `release-info` (from `episodes`, parts of `sources/release`)
- [x] `seekable-tar` (from `tar`)
- [x] `http-kit` (from `router`, `range`, `http-cache`)
- [x] `indexers` (from `sources/*`, `search`)
- [x] `torrent-engine` (from `torrents`, `torrent-ready`, `limits`)
- [x] `playback` (from `media`, `sessions`)
- [x] `apps/server` (`config`, `main`, `errors`, `services/*`, `http/*`)
- [ ] `apps/client` (`lib/*`, page entries)

### File conversion log

Tick when the file is `.ts` in its target location, type-checks, passes the type-aware lint rules and its tests pass.

- **Server, from `src/`:** [x] `config` · [x] `limits` · [x] `range` · [x] `http-cache` · [x] `router` · [x] `tar` · [x] `episodes` · [x] `torrent-ready` · [x] `search` · [x] `torrents` · [x] `media` · [x] `sessions` · [x] `server` (now `app`, `main`, `services/*`, `http/*`)
- **Sources:** [x] `release` · [x] `links` · [x] `torznab` · [x] `prowlarr` · [x] `bitmagnet` · [x] `index` (now `sources.ts`) · [x] `test-helpers`
- **Client:** [x] `lib/api-types` · [x] `lib/urls` · [x] `lib/requests` · [x] `lib/subtitles` · [ ] `lib/capabilities` (stays `.js` until the Player rewrite; see Phase 4) · [x] `lib/progress` · [x] `lib/api` · [x] `lib/ui` · [ ] `search` · [ ] `explore` · [ ] `title` · [ ] `torrent` · [ ] `player`
- **Tests, scripts, config:** [ ] `tests/e2e/fixtures` · [ ] `tests/e2e/playback.test` · [ ] `tests/fixtures/media` · [ ] `tests/integration/peers.test` · [ ] `tools/scripts/setup-indexers` · [ ] `tools/scripts/check-docker` · [ ] `playwright.config`

## Risks and open questions

- **Workspace packages under type stripping:** Decision 3 depends on symlinked workspaces resolving outside `node_modules`. The Phase 0 spike decides this before anything moves. **Resolved 2026-10-17: confirmed working — Node resolves workspace symlinks to their real paths and type-strips the `.ts` files; no fallback needed.**
- **WebTorrent 3 types:** DefinitelyTyped may target an older API. Keep local declarations minimal.
- **Behavior drift during the server split:** Phase 4 moves the most code. Land the moves, the factory introduction and the conversion as separate commits, and run the e2e suite and Docker check after each.
- **Client bundle and caching:** bundled `hls.js` changes player startup and cache behavior; the e2e suite must confirm playback with the production build.
- **Type-aware lint speed:** with `projectService` and project references, linting builds type information for every workspace. If CI lint becomes slow, cache with `--cache` and scope type-aware rules per workspace before dropping any.
- **Formatting churn:** the Phase 0 style pass touches many lines before any move. Keeping it in one ignored commit preserves `git blame`.
- **TypeScript version:** pin an exact version. If the native compiler (TypeScript 7) is stable at Phase 0, evaluate it for `tsc -b` speed. **Resolved 2026-10-17: TypeScript 7.0.2 is out but typescript-eslint 8.71.2 peers `typescript <6.1.0`, so type-aware linting pins TypeScript to 5.9.3.**
- **Resolved 2026-10-18:** `limits` stays duplicated: one 20-line private copy each in `torrent-engine` and `playback`, taking a `busy()` factory so each throws its own package's error. Promote it only if a third user appears.

## Log

- 2026-10-17: TypeScript plan drafted.
- 2026-10-17: Direction change recorded in the architecture doc and roadmap; plan renamed and expanded to include package extraction.
- 2026-10-17: Added ESLint (typescript-eslint, neostandard, package-boundary rules) to the plan.
- 2026-10-17: Checked against the codebase. Nothing from Phases 0–7 exists yet (no workspaces, `tsconfig`, ESLint or `.ts` files; Node 22 baseline). The image moved to Alpine with a separate install stage, so the baseline, Decision 2 and Phase 1's Docker item were updated.
- 2026-10-17: Phase 1 landed in the working tree (uncommitted). Moves: `src/` → `apps/server/src/`, `public/*.js` + `public/lib/` → `apps/client/src/` (relative imports preserved, so only path strings changed: spawn paths in tests, `./src/config.js` in config.test, `publicDir`/`repoRoot` in server.js). Client build: esbuild bundles the five page entries to `dist/client/` with `--minify --sourcemap`; page URLs (`/search.js`…) are unchanged and now map to the bundles, which also serve their `.map` files; `hls.js` is a normal npm import in the player (588 KB minified player bundle vs the old separate vendor file). `npm test` and `npm run test:e2e` run `npm run build` first so the server always has a client to serve. Dockerfile gained a `build` stage (`npm ci` + `npm run build`); runtime copies `apps/`, `public/` and `dist/`. 108 unit + 4 peer + 19 e2e tests pass; the isolated Docker check passes on `linux/arm64` with Node 24 Alpine (remux first segment 235 ms, seek-to-30 s 221 ms). The Playwright fixtures file keeps its `({}, use)` destructuring with an inline `no-empty-pattern` disable — Playwright requires the object pattern.
- 2026-10-17: Phase 0 tooling landed in the working tree (uncommitted by instruction; the formatting pass should be committed separately and listed in `.git-blame-ignore-revs` when the reviewer commits). Spike results: workspace `.ts` packages run under Node type stripping via symlinked real paths (Decision 3 confirmed, no `paths` fallback needed); `node --test` globs find `.ts` tests; `tsc -b` with composite projects works with declarations emitted to `.tsbuild/`. TypeScript 7.0.2 evaluated and rejected: typescript-eslint 8.71.2 peers `typescript <6.1.0`, so type-aware linting requires TypeScript 5.9.3. ESLint 10 loads `eslint.config.ts` via `jiti` (added as a dev dependency). npm 11.20 blocks install scripts unless approved; the native modules WebTorrent needs (node-datachannel, bufferutil, utf-8-validate, utp-native, esbuild) are allowlisted in `package.json` under `allowScripts` so `npm ci` in Docker/CI keeps working. Lint passes with `--max-warnings 0` after a formatting-only pass plus four real fixes (inline `no-unmodified-loop-condition` disable in the player, `no-void` restructure, `curly` braces, `promise/param-names` renames, browser globals for `public/` and `tests/e2e/`). 108 unit + 4 peer tests still pass.
- 2026-10-17: Review pass before committing Phases 0–1 and the first Phase 2 packages. Fixed: the Docker image could not start after dependencies moved into `apps/server/package.json` (a `manifests` stage now feeds every workspace `package.json` to `npm ci`, and the runtime copies `packages/` and only `apps/server`); `.test.ts` files excluded from the image; `npm start` builds the client first (`prestart`); root `tsBuildInfoFile` moved into `.tsbuild/`; ESLint global ignores restored (neostandard's `ignores` option is per-object, so `.tsbuild/*.d.ts` lost the TypeScript plugin) and `node:test` calls allowed by `no-floating-promises`; `globals`/`jiti` pinned; `ip-set`'s pnpm-only preinstall explicitly denied in `allowScripts`. Wired the server to `@magplay/seekable-tar` (deleting `tar.js`) and the client JSDoc to `@magplay/api-contract` (deleting `api-types.js`); removed the empty `http-kit` stub until its step lands.
- 2026-10-17: Simplified tooling configs. ESLint: `eslint.config.ts` → `eslint.config.js` with `defineConfig`, ignores read from `.gitignore`, `recommendedTypeChecked` instead of a hand-picked rule list (dropping `jiti`). This fixed a bug: the old `ban-ts-comment` options set `ts-ignore`/`ts-nocheck` to `false`, which *allows* them; the defaults ban them. TypeScript: shared composite/emit options moved into `tsconfig.base.json` via `${configDir}`, project configs shrank to their real differences, root `tsconfig.json` is a pure solution file. Also: `npm test` and `build` use globs, Playwright config drops defaults, `.nvmrc` 22 → 24 (CI's playback job reads it), `.claude/worktrees/` gitignored so lint doesn't scan other agents' checkouts.
- 2026-10-17: `http-kit` extracted from `router`, `range` and `http-cache` (with their tests, including the range/`attachment` tests split from the old tar tests). The tuple route table became `route()` rows so handlers get typed params; `server.js` maps the package's typed errors to 400/404 inline until `toHttpError` lands.
- 2026-10-17: Package-boundary lint rules enabled. Test files are exempt from the Node built-ins ban because they import `node:test` and `node:assert`.
- 2026-10-17: `apps/server/src/errors.ts` added with `HttpError` and `toHttpError`; `config.js` no longer exports `httpError`, and the server's error handler goes through `toHttpError` (same statuses, `Retry-After` and logging as before).
- 2026-10-17: Pure client helpers converted to `.ts` with their tests; `apps/client` split into app and test projects so tests get Node types without leaking them into page code. Lint `files` globs for client tests name their extensions (`*.test.{js,ts}`), because a bare `*.test.*` also matched `tsconfig.test.json` and made ESLint parse it. Phase 2 complete: typecheck, lint, 110 unit + 4 peer + 19 e2e tests and the isolated Docker check pass (linux/arm64, remux first segment 219 ms, seek-to-30 s 216 ms).
- 2026-10-17: Scope revised with the roadmap reorder. Phases 3–4 stay scheduled (roadmap item 5, after the UI bug fixes, playback instrumentation, real-world acceptance and advisory triage). Phases 5–6 become convert-on-touch, the player is rewritten in TypeScript by the Player roadmap instead of being converted first, and Phase 7 runs after Phase 4. The "every file is `.ts`" success criterion now applies to `packages/*` and `apps/server`.
- 2026-10-17: The owner confirmed playback works on the real NAS, so the roadmap dropped the NAS acceptance and instrumentation gates. Phases 3–4 are now roadmap item 3, right after the UI bug fixes and the advisory triage.
- 2026-10-18: Phase 3 done. `packages/indexers` holds the adapters, search, download links and the BitMagnet browser, strict TypeScript with fixture tests; the env-parsing tests moved to `config.test.ts`, which now calls `loadConfig(env)` in-process instead of spawning Node. `config.ts` exports `loadConfig(env)` (settings store, `current()`, `onChange`); until the Phase 4 split, `config-instance.js` gives the remaining JS modules the old live object. Small differences, all in failure paths: an indexer body that isn't JSON is now a `SourceError` ("… returned invalid JSON") instead of an unexpected 500, and a BitMagnet answer without `data.torrentContent.search` is a `SourceError` instead of a `TypeError`.
- 2026-10-18: Phase 4 done, in three commits: `torrent-engine` (`f171049`), `playback` (`87b8beb`) and the server split. Each package step kept the remaining JS modules working through a short-lived `*-instance.js` shim, deleted by the split. No behaviour change on the success paths; small differences in failure paths: `POST /api/torrents` with a non-string `infoHash`/`magnet`/`linkId` now answers 400 "Send infoHash, magnet or linkId" (was 400 "Not a valid…" or 410), `POST /api/play` coerces `caps` values to booleans, a failing `listen()` prints one line and exits 1 instead of an uncaught stack, and SIGTERM now closes the HTTP server and the torrent engine before exiting (it used to kill ffmpeg and exit at once). The player bundle grows by the parts of `api-contract` it now imports (`sideEffects: false` keeps the settings schema out).
