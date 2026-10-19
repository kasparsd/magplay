# Local playback regression tests

## Run

Requirements: Node >=24, ffmpeg and ffprobe on `PATH`, ffmpeg with `libx264`, AAC and AC3 encoders.

```sh
npm ci
npx playwright install chromium
npm run test:e2e
# Fast Node, loopback-peer and browser tests:
npm run test:all
```

Linux CI installs ffmpeg and uses `npx playwright install --with-deps chromium` for browser system dependencies. `npm test` selects colocated `*.test.js`/`*.test.ts` files under `apps/` and `packages/`; it does not require a browser or generate media. This cross-application suite lives separately in `tests/e2e/*.test.js` and `*.test.ts` and is selected only by Playwright.

For interactive debugging:

```sh
npm run test:e2e -- --headed
npm run test:e2e -- --grep "rapid audio"
npm run test:e2e -- --repeat-each=3
npx playwright show-trace test-results/<failed-test>/trace.zip
```

## What is real

The worker generates an original 90-second 320×180 H.264/AAC MP4 with ffmpeg, a second MP4 episode, an MKV with AC3/AAC audio tracks and embedded SRT, and an external SRT file. No media binaries are committed or downloaded.

`hls-sync.test.ts` needs no browser: it generates a source with a visual flash and a tone at the same instant, remuxes it with the server's real ffmpeg arguments, and decodes the segments with edit lists ignored (as browsers' MSE parsers do) to check that audio and video stay aligned from a fresh start and after a resume.

It creates a private, trackerless torrent and places its metadata and complete content in a temporary production-format cache. The actual server runs as a child process on an ephemeral port and uses real WebTorrent hash verification/read streams, `/raw` Range responses, ffprobe, ffmpeg, HLS output, hls.js and browser media decoding. Playback assertions require video dimensions, no media errors, a playing state, and an increasing decoded-frame count—not just successful HTTP responses.

A loopback Torznab fixture supplies the search result. Browser requests outside the application origin are blocked. Tests require no live indexer, public swarm or configured `.env`. Production configuration is passed to an isolated child process, not changed in the running app.

Coverage:

- Eight concurrent cold-cache torrent/probe requests share initialization.
- Search → torrent → direct MP4 playback, byte ranges and seeking.
- MKV/AC3 remux playback, audio switching and seeking before the HLS session offset.
- Rapid audio changes during an intentionally delayed response preserve the playhead and leave one current HLS session.
- Embedded/external subtitle cue timing after an HLS restart, final cues, and repeated selection.
- External subtitles during direct playback without an HLS session.
- Failed playback POST or malformed successful JSON followed by successful UI retry.
- Back removes the previous HLS session; Forward can play again.
- Cancelling the next-episode countdown prevents navigation; pagehide clears the countdown and polling.
- Leaving during probing or before a playback response is known cannot strand a new HLS session; a restored activation can play again.
- Direct/HLS per-file resume, Start over, absolute HLS offsets, completion detection and blocked storage.
- Retryable HLS admission overload does not disrupt other admitted players.

- Cache headers, conditional GET/HEAD, raw/tar ranges, completed/progressive subtitles and HLS session freshness.
- Real generated non-media single-file and tar downloads, download-only phone layout, mixed-torrent Resume and Explore-only adult-setting copy.
- Cached torrent file lists without torrent activation, Settings save/lock/source-field behavior, Debug polling/focus, and connection-test warnings.

The deliberately failed/malformed POST responses and delayed audio-switch response are the only playback-response interventions. Codecs, probing, streams and successful decisions are not mocked. Each test uses a fresh browser context; each worker owns its server/cache. Teardown navigates away, stops leftover sessions through the API, shuts down the child and deletes its temporary files. Failure artifacts contain a screenshot, trace and server log.

## What this does not prove

- Peer discovery, missing-piece download and dead-swarm behavior: this browser fixture is already cached. The separate [loopback integration suite](../integration/README.md) now covers those paths without a browser.
- Actual server CPU/memory/disk performance, Docker builds, or large-file cache pressure.
- Safari/Firefox codec behavior, hardware decoding or external-player launches.
- Browser back/forward-cache eligibility: the test exercises Back/Forward navigation, which may reload the page depending on the browser. A restored-document lifecycle test is still useful.

The default suite is Chromium-only. Keep public-network tests and device acceptance checks separate so these regressions stay deterministic.

Application and package code is checked with strict TypeScript, unused-code checks and type-aware linting. Browser fixtures and tests still convert to TypeScript on touch; passing this suite does not imply they have all been converted.

The download UX regressions use `tests/e2e/tsconfig.json`, referenced by the root typecheck. `fixtures.d.ts` describes the fields they consume from the existing JavaScript harness; `types/create-torrent.d.ts` declares only the generated-fixture API, and the project reuses the torrent-engine parse-torrent declaration. These tests add original non-media bytes and metadata to the worker’s isolated cache; they do not mock file lists or download responses. They verify byte equality and tar names/content, not whether the synthetic `.iso` or `.flac` files are usable disk images/audio.
