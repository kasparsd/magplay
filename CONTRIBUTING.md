# Contributing

## Project

This is a greenfield project. Do not spend effort on data migrations, backward compatibility, or preserving behavior for hypothetical existing users. Prefer a clean design over keeping an earlier choice.

## Documentation

Canonical documentation is organized by concern in `docs/`. Update the relevant document in place when a decision changes; do not add a parallel review or summary for the same concern. `docs/research/` holds planning inputs and `docs/checkpoints/` holds dated evidence; neither is canonical.

When starting a feature, create or continue `docs/plans/{feature-description}.md` with the plan, goals and progress. Use soft line breaks in documentation, not hard-wrapped paragraphs.

## Release notes

Every change adds one changeset for `@magplay/server`, the package that ships the app. Use `npm run changeset` for the prompt. The changelog is [CHANGELOG.md](CHANGELOG.md). Bump rules and release steps are in [docs/releases.md](docs/releases.md).

## Working on it

```bash
npm install
```

```bash
npm start                 # builds the client, then serves; cache lands in ./data; set TORZNAB_URL etc. to configure an indexer
```

**macOS local-network permission:** if startup succeeds but source requests or Explore count warming fail with `EHOSTUNREACH` (for example, `can't reach bitmagnet.local:3333 (EHOSTUNREACH)`), check **System Settings → Privacy & Security → Local Network**. Enable access for the app hosting your terminal if it is listed (Terminal, iTerm, or your editor for an integrated terminal), then quit and reopen that app and run `npm start` again. Allow local-network access if macOS prompts. See [Apple's local-network permission guide](https://support.apple.com/guide/mac-help/mchla4f49138/mac).

Check connectivity from the same terminal, replacing the example URL with your BitMagnet address:

```bash
node -e 'fetch("http://bitmagnet.local:3333/torznab/api?t=caps", { signal: AbortSignal.timeout(5000) }).then(r => console.log(r.status)).catch(console.error)'
```

`200` confirms an HTTP response from the endpoint; `401` or `403` means it is reachable but requires authentication. If `EHOSTUNREACH` persists after allowing access, check the host address, LAN connection, VPN routing and firewall. This error can have causes other than macOS permissions.

```bash
npm run dev               # rebuilds the client and restarts the server on change
```

```bash
npm run typecheck         # tsc -b over every workspace
npm run lint              # ESLint (neostandard + type-aware rules), no warnings allowed
```

```bash
npm test                    # Fast Node regression tests
npx playwright install chromium
npm run test:e2e             # Generated local media + real Chromium playback
npm run test:peers           # Real loopback TCP transfer/failure cases
npm run test:all             # Fast + peer + browser suites
```

Playback tests need `ffmpeg` and `ffprobe` on `PATH`, with libx264, AAC and AC3 encoders. They use an isolated temporary torrent cache and a local indexer fixture; no public swarm or running indexer is needed. See [tests/e2e/README.md](tests/e2e/README.md) for coverage, debugging and limitations.

Node 24+, ES modules, npm workspaces. The code is moving into isolated packages and strict TypeScript ([plan](docs/plans/package-boundaries-and-typescript.md), [architecture](docs/architecture.md)); the server runs `.ts` packages directly through Node type stripping, with no compile step.

- `apps/server/src/`: the Node service. `main.ts` is the entry point (config, startup checks, graceful shutdown); `app.ts` builds the server from the packages; `config.ts` parses env and saved settings; `services/` coordinates the packages (play, tabs, search, Explore, playlists, subtitles, status); `http/` holds the routes, matched by the `http-kit` router, and the media and error handling.
- `apps/client/src/`: one script per page (`search.js`, `torrent.js`, `player.js`, `explore.js`, `title.js`), plus `lib/ui.ts` (DOM, formatting, `menu()`, copy buttons, tiles, release rows, per-browser memory), `lib/api.ts` (DOM-independent JSON transport) and `lib/urls.ts` (every URL the pages link to, including the external-player links). esbuild bundles each page, including `hls.js`, into `dist/client/` (`npm run build`); the server serves those bundles at the same URLs.
- `public/`: HTML and CSS, served as-is.
- `packages/`: `api-contract` (JSON wire types shared by server and client), `release-info` (file kinds, episode numbers, title badges), `indexers` (Torznab, Jackett, Prowlarr and BitMagnet adapters, merged search, download links), `torrent-engine` (the WebTorrent client, torrent cache and eviction), `playback` (ffprobe, the direct/remux/transcode decision, HLS ffmpeg sessions), `seekable-tar` (range-addressable tar streams) and `http-kit` (router with typed route params, Range parsing, conditional caching and `serveFile`).

### Test layout

Keep fast tests next to their modules as `*.test.js` or `*.test.ts`, for example `packages/http-kit/src/router.test.ts` and `packages/seekable-tar/src/index.test.ts`. `npm test` builds the client, then discovers these files under `apps/` and `packages/`, excluding helpers and browser integration tests. Run one file with `node --test apps/client/src/lib/api.test.ts`. Cross-application Playwright tests live in `tests/e2e/*.test.js` and are selected separately by `playwright.config.js`.

Indexer adapters take `fetch` as a parameter and use recorded/synthetic responses in `packages/indexers/src/test-fixtures/`, with shared helpers in `packages/indexers/src/test-helpers.ts`. The fast suite covers source parsing/configuration/errors/timeouts, deduplication, download-link resolution, episodes/badges, tar/ranges, media decisions, session lifecycle, HTTP caching and API-client transport. The Chromium suite exercises cached-torrent playback, seeking, audio switching, subtitles, retries, navigation and media cache policies. [docs/checkpoints/2026-10-17-build-report.md](docs/checkpoints/2026-10-17-build-report.md) retains historical live-swarm and device acceptance checks.

Docker excludes tests, fixture data and helpers from its build context, and the runtime image carries only the server, the packages, `public/` and the built bundles. Node serves the page bundles and their source maps through an explicit allowlist; client sources and colocated tests are never exposed.

### JSON API client

Import `api` from `apps/client/src/lib/api.ts`. The client keeps same-origin relative URLs, forwards fetch options/AbortSignal/cache settings, preserves caller headers when posting JSON, and never retries implicitly. HTTP errors are `ApiError`s exposing `status` and the server's string error message (or `HTTP <status>` for a non-JSON proxy error). Invalid or empty JSON on a successful response now produces an explicit `Invalid JSON response` error instead of silently returning `{}`. Network, body-stream and abort failures retain their original error/reason. Use ordinary `fetch` for HEAD requests, text subtitles, playlists and media bytes.

`@magplay/api-contract` types probe results, browser capability keys (and holds `CODEC_KEYS`), play requests, direct/HLS decisions, torrent/session status, search results, torrent file lists and Explore responses; the server's handlers are typed against the same interfaces. They are compile-time contracts, not runtime response validation.

### Player helpers

`apps/client/src/lib/capabilities.js` measures codec support from explicitly supplied media/browser APIs, without user-agent assumptions or browser globals at import time. `apps/client/src/lib/subtitles.ts` parses ffmpeg WebVTT snapshots, preserving cue text/timing and rejecting invalid timestamps. It is not a complete WebVTT renderer: the page still owns progressive-file handling, subtitle timeline offsets, polling and `VTTCue` creation. These helpers and `lib/progress.ts` have colocated tests. Targeted page/request/timer ownership is implemented without a controller rewrite; further extraction is conditional on an actual maintenance need.

