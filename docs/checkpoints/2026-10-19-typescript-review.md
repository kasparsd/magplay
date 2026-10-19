# Roadmap reconciliation and TypeScript Phase 7 — 2026-10-19

Recent work was checked against the roadmap through `aa4fba5`. Cached data reuse (`8cdcad8`), cached file lists (`512c108`), expanded taxonomy (`e48a52a`) and the Settings follow-ups (`00b3176`, `0446686`, `aa4fba5`) are now recorded as delivered. The taxonomy is partial: non-media download messaging remains open, and the adult toggle filters classified BitMagnet Explore/title results, not generic source search. These remaining items stay in the taxonomy plan and roadmap. Real device acceptance and real-server performance/avahi measurements still require owner evidence; no local test closes them.

## Tightening decisions

- Enabled `noUnusedLocals` and `noUnusedParameters`. Removed the unused speed-test request argument and Settings store dependency from status checks.
- Evaluated `noPropertyAccessFromIndexSignature`: it mainly changes spelling for dynamic env/schema/dataset/upstream records. Deferred it; the review found no additional defect from those diagnostics.
- Evaluated the installed `strictTypeChecked` and `stylisticTypeChecked` presets over all application/package TypeScript: 569 findings before changes. Selected `restrict-plus-operands`, `no-unnecessary-type-conversion` and `use-unknown-in-catch-callback-variable`. Numeric string concatenation now uses explicit interpolation, unnecessary conversions are removed, and rejection callbacks narrow unknown errors. Existing recommended rules, exhaustive switches and type imports remain enabled.
- Full preset adoption was declined: numeric interpolation, concise void callbacks, empty cleanup handlers, array spelling, defensive runtime checks and collection assertions accounted for most findings. The Unicode string-spread finding in the logger is intentional code-point truncation (not grapheme segmentation); deprecated clipboard fallback and browser-vendor workaround findings need their existing compatibility behavior. No rules were globally disabled to make the selected checks pass.
- Updated README dependency/layout guidance, architecture, roadmap and both test READMEs. There is no DEPENDENCIES.md; the existing README dependency section remains canonical. Client pages and external tests/tooling remain on-touch conversions, with no framework/controller extraction or desktop implementation.

## Assertion and suppression audit

An AST scan covered every TypeScript file under `apps/` and `packages/`: zero explicit `any` keywords, 73 non-null expression occurrences before changes, and two definite-assignment assertions. Each non-null occurrence was reviewed in its surrounding control flow. Retained assumptions are grouped below by invariant rather than introducing one suppression per occurrence.

| Sites | Why the assertion is valid in current callers |
| --- | --- |
| Client `naming`, `player-speed`, `sparkline`, `speedtest` | Splitting a nonempty name always returns a first field; speed indices are clamped into a constant nonempty list; chart runs are nonempty and single-point expansion is handled; connection measurements use the positive default ping count. |
| Client `status-menu`, `settings` | First message character is read after a nonempty check; the disclosure owns its summary; section ids originate in the same constant section catalog. |
| Server `http/hls`, `http/media`, `http/routes`, `settings-store` | The segment fallback key is a constant; tar callbacks use layout-generated indices; validated single-source configuration yields one entry; single-item validation preserves that item. |
| Server `services/search` and indexers `bitmagnet` | Magnet parsing has validated the hash/name before release normalization; title groups are created only when pushing their first release. |
| Server `services/explore`, `services/tabs`; indexers `search`; playback `media`; torrent-engine `engine`; observability `logger` | LRU eviction loops run only while a map/list is over its positive limit, so the oldest entry exists. |
| `http-kit/router`, observability `metrics` | Successful regular expressions guarantee the capture or path component being indexed. |
| Client tests (`playback-status`, `setting-rules`, `speedtest`), server tests (`app`, `mdns`, `services/play`), package tests (`indexers/*`, observability `logger`, seekable-tar) | Deliberate fixture fields, recorded mock calls, configured callbacks, known test samples and layout-produced indices; failed expectations remain test failures. The two definite-assignment assertions in `services/play.test.ts` are assigned synchronously by the Promise constructor. |

Removed double casts from production config and browser preferences: env-only settings now preserve a discriminated schema union and supply schema metadata explicitly; preferences narrow their validated dynamic values before returning the typed API. Removed double casts from the env-only settings test and connection test's storage/fetch stand-ins.

The remaining production double cast is `indexers/release.ts`'s response-body iterator: Node fetch supports async iteration while this project's default DOM declarations omit it. A local comment records that boundary. Adding explicit DOM async-iterator libraries was tried, but also changes fetch body typings for fixture `Uint8Array` buffers; retained the narrow existing boundary instead of widening all package globals.

Remaining test double casts are intentional partial `IncomingMessage` (`http-kit/origin`), fake ffmpeg child processes (`playback/hls`, server `app` and `services/tabs`), partial play engine/media/tab services (`services/play`), partial subtitle services (`services/subtitles`), and the deliberately invalid untyped progress argument (`client/progress`). Each supplies the fields read by the exercised path; none is a production assertion.

All five inline lint suppressions were reviewed and retained with their existing reasons: async fetch mocks (`client/api.test`), async tar readers (`seekable-tar/index.test`), preservation of caller abort reasons (`client/requests`), generation changes between async polls (`player`) and Playwright's required destructured fixture parameter (`e2e/fixtures`). The sole `@ts-expect-error` is `http-kit/router.test.ts`'s negative check for a nonexistent captured route parameter. There are no `@ts-ignore` directives.

## Validation

- `npm run typecheck`, `npm run lint`, `npm run changeset:check` and `git diff --check` passed.
- `npm run test:all` passed: 238 fast tests, four peer runner entries (parent plus three scenarios), and all 60 Chromium tests. Browser playback assertions require advancing decoded frames; the run covered direct/remux playback, seeks, track switches, blocked storage, lifecycle cleanup, Settings and cache behavior. Node v26.11.1 was used locally; this is not a new Node 24 or image acceptance run.
- Suites were run outside the sandbox because local fixture listeners were denied (`listen EPERM`) inside it. The combined run completed successfully; the initial sandbox denial is not an application regression.
- Docker acceptance could not run because the Docker daemon socket was absent. This checkpoint does not replace the previous arm64 image acceptance or real-server/device evidence.
- An empty Changeset accompanies the internal tightening and contributor documentation; no dependency version, wire contract or intended user behavior changed.
