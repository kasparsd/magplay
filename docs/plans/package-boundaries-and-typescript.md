# Package boundaries and TypeScript

Status: **In progress (Phases 0–1 done)** · Owner: unassigned · Last updated: 2026-10-17

The target structure, its reasons and its rules are canonical in [architecture.md](../architecture.md); priority and completion evidence are in [the roadmap](../roadmap.md). This plan tracks how we get there.

## Goal

Reorganize the code into isolated internal packages with one-way dependencies, convert every first-party file to strict TypeScript and bring it under ESLint in the same pass. Each file is converted and moved once.

### Success criteria

- All first-party code lives in `packages/*`, `apps/*`, `tests/` and `tools/scripts/` as `.ts`. No first-party `.js`/`.mjs` remains outside gitignored build output.
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
4. **Type checking with project references:** `tsconfig.base.json` holds compiler options. Each package and app has a `tsconfig.json` with `composite` and references to its dependencies. Packages use Node types without DOM; `apps/client` uses DOM without Node types; `api-contract` and `release-info` use neither. `npm run typecheck` runs `tsc -b`. Project references need declaration output, so emit goes to a gitignored `.tsbuild/` used only by the type checker.
5. **Strict options:** `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `noFallthroughCasesInSwitch`, `isolatedModules`, `module`/`moduleResolution: nodenext`, `target: es2023` (raise if Node 24 allows). Unconverted files are covered by `allowJs` with `checkJs: false` until their phase.
6. **Client build:** esbuild bundles one ESM file per page into `dist/client/` with sourcemaps; `hls.js` is imported from npm.
7. **Typed errors:** each package exports its error classes. A single `toHttpError(err)` in `apps/server/http/` maps them to status codes and `Retry-After`.
8. **Third-party types:** use bundled or `@types/*` when they match the installed major; otherwise minimal declarations in the consuming package's `src/types/<pkg>.d.ts`, covering only the API we use.
9. **Tests:** `node:test` from `.ts` sources and Playwright with native TypeScript. Unit tests stay next to their modules inside each package.
10. **Linting:** ESLint (latest major, pinned) with one root `eslint.config.ts` (flat config) covering all workspaces.
    - **Style:** neostandard with `ts: true`. It continues the existing `standard` style and handles formatting through its stylistic rules, so there is no Prettier.
    - **Types:** typescript-eslint `recommendedTypeChecked` using `projectService`, plus `no-floating-promises`, `no-misused-promises`, `switch-exhaustiveness-check`, `consistent-type-imports`, `no-explicit-any` and `ban-ts-comment` (`@ts-expect-error` allowed with a description). Type-aware rules apply to `.ts` files only.
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
- [x] Add `eslint.config.ts` with neostandard style rules for the existing `.js` and the type-aware rule set for `.ts`; add `lint` and `lint:fix` scripts. Confirm ESLint loads a TypeScript config on the Node baseline.
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

- [ ] `api-contract`: `api-types.js` → real types (discriminated `PlaybackDecision` union etc.); the client imports it; delete the JSDoc file.
- [ ] `release-info`: move `episodes` detection, badges and `PROGRAM_EXT`/`contentWarning` out of `sources/release.js` and `episodes.js`; `indexers` and the server import from it. Convert with tests.
- [ ] `seekable-tar`: move `tar.js` and tests; replace `Buffer` with `Uint8Array` if cheap; convert.
- [ ] `http-kit`: move `router`, `range`, `http-cache` and tests; type route params from path patterns; convert.
- [ ] Enable the package-boundary lint rules as soon as the first package exists.
- [ ] Introduce `apps/server/src/errors.ts` (`toHttpError`) and stop exporting `httpError` from `config.js`; packages from here on throw typed errors.
- [ ] Convert pure client helpers: `lib/urls`, `lib/requests`, `lib/subtitles`, `lib/progress`, `lib/api`, `lib/ui`.

### Phase 3: Indexers

- [ ] Move `sources/*` and `search` into `indexers`; move `sourcesFromEnv`/`bitmagnetUrl` env parsing into `apps/server/config.ts`, so config no longer imports an adapter.
- [ ] Replace `httpError` in `search` with indexer errors (`SearchTimeout`, `SourceError`, `LinkExpired`).
- [ ] Define a `Source` interface and the `Release` type in one place; parse functions for Torznab XML, Prowlarr JSON and BitMagnet GraphQL; fixtures exercise them.
- [ ] Convert with tests; revisit the no-validation-library decision.

### Phase 4: Torrent engine, playback and the server split

- [ ] Types for `webtorrent` and `parse-torrent` covering the API we use.
- [ ] `torrent-engine`: `createTorrentEngine(options)` with `close()`; move metadata store, eviction, deadlines (`torrent-ready`) and status; file handles expose cancellable range reads. Raw/tar HTTP serving moves to `apps/server/http/` using `http-kit` and `seekable-tar`.
- [ ] `playback`: `probe(input)`, `decide(info, caps, policy)`, `ffmpegArgs`, `subtitleToVtt`, `createHlsSessions(options)` with `close()`. `rawUrl` and the app port leave the package; the app passes the `/raw` loopback URL. Tab fencing and `serveHls` move to the app. Export codec keys; `apps/client` `capabilities` imports them.
- [ ] Split `server.js`: `config.ts` (typed, validated once), `main.ts` (create packages, startup checks, facet warming, signal handling and `close()`), `services/` (play, explore, playlists, subtitles) and `http/` (routes, request parsing from `unknown`, `toHttpError`).
- [ ] Tests construct packages with factories instead of relying on module state; add a graceful-shutdown test.
- [ ] Convert with tests; remove `allowJs` from the server and packages.

### Phase 5: Client pages

- [ ] Convert `capabilities`, then the `search`, `explore`, `title`, `torrent` and `player` entries. The player keeps its imperative lifecycle ([lifetime rules](../lifecycle.md)); per-activation state objects are fine where they fall out naturally.
- [ ] Add a typed `requireElement(selector, ctor)` helper instead of non-null assertions.
- [ ] Remove `allowJs` from `apps/client`.

### Phase 6: Tests, scripts and config files

- [ ] `tests/e2e/*`, `tests/fixtures/*`, `tests/integration/*` (types for `bittorrent-tracker` and `create-torrent`).
- [ ] `tools/scripts/setup-indexers` and `tools/scripts/check-docker` → `.ts`; `playwright.config` → `.ts`.
- [ ] Remove `allowJs` everywhere; add a CI check that fails on first-party `.js`/`.mjs`.
- [ ] Remove the JavaScript-only section of `eslint.config.ts`; type-aware rules now cover every file.

### Phase 7: Tighten and document

- [ ] Review every `any`, `as unknown as`, non-null `!` and `@ts-expect-error`; justify or remove each.
- [ ] Consider `noPropertyAccessFromIndexSignature` and `noUnusedLocals`/`noUnusedParameters`.
- [ ] Evaluate typescript-eslint `strictTypeChecked` and `stylisticTypeChecked`; enable the rules that find real issues without noise. Review every inline `eslint-disable`.
- [ ] Update `README.md` (layout, dev workflow, requirements), `DEPENDENCIES.md`, `docs/architecture.md` (mark delivered, remove the findings table if obsolete), the roadmap entry and the test READMEs.
- [ ] Mark this plan complete.

## Progress tracker

| Phase | Scope | Status | PR / commit | Notes |
| --- | --- | --- | --- | --- |
| 0 | Tooling foundation | ✅ Done | | TypeScript pinned to 5.9.3, not 7 (typescript-eslint 8 peers `<6.1.0`); ESLint 10 needs `jiti` for the TS config; npm 11.20 gates install scripts, allowed native ones via `allowScripts` in package.json |
| 1 | Apps skeleton and client build | ✅ Done | `54cd9df` | esbuild `--minify --sourcemap`; URLs unchanged (`/search.js` etc. now served from `dist/client/`); `npm test` and `test:e2e` build first; hls.js moved to devDependencies (bundled at build time, never served); Docker check passed on Node 24 Alpine |
| 2 | Contract and pure packages | ⬜ Not started | | |
| 3 | Indexers | ⬜ Not started | | |
| 4 | Torrent engine, playback, server split | ⬜ Not started | | |
| 5 | Client pages | ⬜ Not started | | |
| 6 | Tests, scripts, config files | ⬜ Not started | | |
| 7 | Tighten and document | ⬜ Not started | | |

Legend: ⬜ Not started · 🟨 In progress · ✅ Done · ⛔ Blocked

### Package checklist

Tick when the package exists, has its own `package.json` and `tsconfig`, is fully `.ts`, type-checks, passes lint and its tests pass.

- [ ] `api-contract` (from `api-types`)
- [ ] `release-info` (from `episodes`, parts of `sources/release`)
- [ ] `seekable-tar` (from `tar`)
- [ ] `http-kit` (from `router`, `range`, `http-cache`)
- [ ] `indexers` (from `sources/*`, `search`)
- [ ] `torrent-engine` (from `torrents`, `torrent-ready`, `limits`)
- [ ] `playback` (from `media`, `sessions`)
- [ ] `apps/server` (`config`, `main`, `errors`, `services/*`, `http/*`)
- [ ] `apps/client` (`lib/*`, page entries)

### File conversion log

Tick when the file is `.ts` in its target location, type-checks, passes the type-aware lint rules and its tests pass.

- **Server, from `src/`:** [ ] `config` · [ ] `limits` · [ ] `range` · [ ] `http-cache` · [ ] `router` · [ ] `tar` · [ ] `episodes` · [ ] `torrent-ready` · [ ] `search` · [ ] `torrents` · [ ] `media` · [ ] `sessions` · [ ] `server`
- **Sources:** [ ] `release` · [ ] `links` · [ ] `torznab` · [ ] `prowlarr` · [ ] `bitmagnet` · [ ] `index` · [ ] `test-helpers`
- **Client:** [ ] `lib/api-types` · [ ] `lib/urls` · [ ] `lib/requests` · [ ] `lib/subtitles` · [ ] `lib/capabilities` · [ ] `lib/progress` · [ ] `lib/api` · [ ] `lib/ui` · [ ] `search` · [ ] `explore` · [ ] `title` · [ ] `torrent` · [ ] `player`
- **Tests, scripts, config:** [ ] `tests/e2e/fixtures` · [ ] `tests/e2e/playback.test` · [ ] `tests/fixtures/media` · [ ] `tests/integration/peers.test` · [ ] `tools/scripts/setup-indexers` · [ ] `tools/scripts/check-docker` · [ ] `playwright.config`

## Risks and open questions

- **Workspace packages under type stripping:** Decision 3 depends on symlinked workspaces resolving outside `node_modules`. The Phase 0 spike decides this before anything moves. **Resolved 2026-10-17: confirmed working — Node resolves workspace symlinks to their real paths and type-strips the `.ts` files; no fallback needed.**
- **WebTorrent 3 types:** DefinitelyTyped may target an older API. Keep local declarations minimal.
- **Behavior drift during the server split:** Phase 4 moves the most code. Land the moves, the factory introduction and the conversion as separate commits, and run the e2e suite and Docker check after each.
- **Client bundle and caching:** bundled `hls.js` changes player startup and cache behavior; the e2e suite must confirm playback with the production build.
- **Type-aware lint speed:** with `projectService` and project references, linting builds type information for every workspace. If CI lint becomes slow, cache with `--cache` and scope type-aware rules per workspace before dropping any.
- **Formatting churn:** the Phase 0 style pass touches many lines before any move. Keeping it in one ignored commit preserves `git blame`.
- **TypeScript version:** pin an exact version. If the native compiler (TypeScript 7) is stable at Phase 0, evaluate it for `tsc -b` speed. **Resolved 2026-10-17: TypeScript 7.0.2 is out but typescript-eslint 8.71.2 peers `typescript <6.1.0`, so type-aware linting pins TypeScript to 5.9.3.**
- **Open:** does `limits` stay duplicated privately (current plan) or become a tiny shared package? Decide when the second copy is written in Phase 4.

## Log

- 2026-10-17: TypeScript plan drafted.
- 2026-10-17: Direction change recorded in the architecture doc and roadmap; plan renamed and expanded to include package extraction.
- 2026-10-17: Added ESLint (typescript-eslint, neostandard, package-boundary rules) to the plan.
- 2026-10-17: Checked against the codebase. Nothing from Phases 0–7 exists yet (no workspaces, `tsconfig`, ESLint or `.ts` files; Node 22 baseline). The image moved to Alpine with a separate install stage, so the baseline, Decision 2 and Phase 1's Docker item were updated.
- 2026-10-17: Phase 1 landed in the working tree (uncommitted). Moves: `src/` → `apps/server/src/`, `public/*.js` + `public/lib/` → `apps/client/src/` (relative imports preserved, so only path strings changed: spawn paths in tests, `./src/config.js` in config.test, `publicDir`/`repoRoot` in server.js). Client build: esbuild bundles the five page entries to `dist/client/` with `--minify --sourcemap`; page URLs (`/search.js`…) are unchanged and now map to the bundles, which also serve their `.map` files; `hls.js` is a normal npm import in the player (588 KB minified player bundle vs the old separate vendor file). `npm test` and `npm run test:e2e` run `npm run build` first so the server always has a client to serve. Dockerfile gained a `build` stage (`npm ci` + `npm run build`); runtime copies `apps/`, `public/` and `dist/`. 108 unit + 4 peer + 19 e2e tests pass; the isolated Docker check passes on `linux/arm64` with Node 24 Alpine (remux first segment 235 ms, seek-to-30 s 221 ms). The Playwright fixtures file keeps its `({}, use)` destructuring with an inline `no-empty-pattern` disable — Playwright requires the object pattern.
- 2026-10-17: Phase 0 tooling landed in the working tree (uncommitted by instruction; the formatting pass should be committed separately and listed in `.git-blame-ignore-revs` when the reviewer commits). Spike results: workspace `.ts` packages run under Node type stripping via symlinked real paths (Decision 3 confirmed, no `paths` fallback needed); `node --test` globs find `.ts` tests; `tsc -b` with composite projects works with declarations emitted to `.tsbuild/`. TypeScript 7.0.2 evaluated and rejected: typescript-eslint 8.71.2 peers `typescript <6.1.0`, so type-aware linting requires TypeScript 5.9.3. ESLint 10 loads `eslint.config.ts` via `jiti` (added as a dev dependency). npm 11.20 blocks install scripts unless approved; the native modules WebTorrent needs (node-datachannel, bufferutil, utf-8-validate, utp-native, esbuild) are allowlisted in `package.json` under `allowScripts` so `npm ci` in Docker/CI keeps working. Lint passes with `--max-warnings 0` after a formatting-only pass plus four real fixes (inline `no-unmodified-loop-condition` disable in the player, `no-void` restructure, `curly` braces, `promise/param-names` renames, browser globals for `public/` and `tests/e2e/`). 108 unit + 4 peer tests still pass.
- 2026-10-17: Review pass before committing Phases 0–1. Fixed: the Docker image needs every workspace `package.json` once dependencies live in `apps/server/package.json` (a `manifests` stage now feeds them to `npm ci`, and the runtime copies only `apps/server`); `.test.ts` files excluded from the image; `npm start` builds the client first (`prestart`); root `tsBuildInfoFile` moved into `.tsbuild/`; ESLint global ignores restored (neostandard's `ignores` option is per-object, so `.tsbuild/*.d.ts` lost the TypeScript plugin) and `node:test` calls allowed by `no-floating-promises`; `globals`/`jiti` pinned; `ip-set`'s pnpm-only preinstall explicitly denied in `allowScripts`.
