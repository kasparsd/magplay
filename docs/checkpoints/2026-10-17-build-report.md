# magplay build report (2026-10-17)

The checked-in test report uses sanitized, locally seeded open-content fixtures (generated with ffmpeg: H.264 + AC3 5.1 + AAC + SRT + ASS MKV ×6, an H.264/AAC MP4, and an HEVC Main10 + AC3 MKV). It does not document or depend on a personal host, IP address, commercial catalog, or public swarm.

## Acceptance tests

| # | Result | Notes |
|---|---|---|
| 1 | **Pass** | "Big Buck Bunny S01" on the real BitMagnet: 13 results, season packs included, one with no `seeders` attr (shown blank, sorted last). Items with missing fields are kept; items with no title are dropped. |
| 2 | **Pass** | Real `Big Buck Bunny.S01.COMPLETE.720p.BluRay.x264-OpenContent`: metadata in under 1 s, 6 videos as S01E01–S01E06, the .txt and samples excluded. Download stays ~0 with nothing selected, apart from ~2 MB: WebTorrent fetches one random piece from each new peer to validate it (built in). |
| 3 | **Pass** (Chromium, Firefox) | Real E01 (H.264 MKV): `remux`, video copied, first segment in 1 s, playing in 2.3 s, ffmpeg 200–3000x at ~0% CPU while paused ahead. Seeking to 20:50 restarted the session and played in 1.75 s. Audio switch (fixture AC3→AAC track) restarted at the same position in 1.3 s. In real Firefox 157: remux with AC3→AAC, playing (watched from the server; I couldn't see the screen). |
| 4 | **Pass** | Fixture MP4: `direct`, 206 Range responses, seek to 20:00 in 1.3 s, no ffmpeg running. |
| 5 | **Pass** | HEVC 10-bit with Firefox caps: 422 with the message, before any ffmpeg starts. Real Safari 27: `remux`, output tagged `hvc1`, playing. |
| 6 | **Pass** | Closing the tab: ffmpeg killed and session dir removed immediately (beacon). A session with no pings is reaped in ≤ 55 s. Idle torrent unloaded after `IDLE_TORRENT_MIN`. With `CACHE_MAX_GB=0.5`, LRU folders were evicted down to 0.27 GB, and the loaded torrent was kept. |
| 7 | **Pass** | Dead infohash: clean 504 "No peers found for this torrent in 15 s; try another release" (`METADATA_TIMEOUT_S=15`). `/health` and search answered normally meanwhile. |
| 8 | **Pass** | SRT and ASS inside the MKV, and an external `.srt` in the torrent, are selectable and timed correctly after HLS seeks (the external file is shifted by the session offset). Image subs are listed as disabled. |

External players (added on request): `.m3u` for one file and for the whole season, named `/raw/.../File.mkv` URLs built from the request's host. VLC played the HEVC 10-bit + AC3 fixture through the `.m3u` (VideoToolbox hardware decode), seeking via Range; no ffmpeg on the server. IINA/Infuse/Android intent links are built from their documented formats but **untested** (not installed).

## Fixed along the way

- uTP and the DHT both bound UDP `TORRENT_PORT` (`EADDRINUSE`). uTP is now off: peers use TCP, the DHT keeps UDP.
- WebTorrent loads `node-datachannel` (native WebRTC) at startup, so the image must run `npm ci` with install scripts (they download a prebuilt binary).
- A fully cached torrent couldn't be reopened without peers after being unloaded. Its metadata is now saved as `torrents/<ih>/meta.torrent`, so it reloads in 0.1 s offline.
- ffmpeg remux runs at 100–3000x, so it would write the whole episode to disk. It's now paused (SIGSTOP) 4 min ahead of playback and resumed at 2 min. Sessions are killed on shutdown so paused ffmpegs don't outlive Node.
- Firefox blocks autoplay with sound on a new tab, so the player falls back to muted autoplay with a "click to unmute" hint.

## Guesses and deviations

- **webtorrent 3.0.21** instead of v2 (current major; same API). Torrents are added with `deselect: true`. Files aren't `select()`ed for streaming: the read stream's own selection prioritizes pieces from the playhead onwards, which avoids pre-downloading whole files.
- `parse-torrent` added as a direct dependency (already inside webtorrent) to get the infohash from magnets and .torrent files. Prowlarr-style download `link`s (.torrent or a redirect to a magnet) are supported.
- Subtitles in HLS modes are written by the same ffmpeg as WebVTT and fetched progressively by the player, so they don't force a full-file read. `/subs/...` is used for direct mode and external files.
- The player sends `pos` in its stats ping (every 2 s), which keeps the session alive and drives the pause-ahead logic. `DELETE /api/play/:id` also accepts `POST` for `sendBeacon`.
- Direct play is only chosen for the first audio track. Picking another track remuxes, because browsers can't switch tracks in a plain `<video>`.
- About 1,200 lines of JS plus ~130 lines of HTML/CSS. That's over the ~1,000 target, because of the external-player hand-off, progressive subtitles and the pause-ahead throttle.
- The image is ~1 GB, mostly Debian ffmpeg's libraries.
- `.local` names don't resolve inside a Linux container, so use `bitmagnet:3333` or an IP on the NAS.

## Not done

- **Phase 2 (WebCodecs client decode)** was not started. External players now cover HEVC/10-bit/DTS/TrueHD/PGS with hardware decoding, which takes away most of the reason for it. I recommend dropping it unless in-browser HEVC in Firefox matters.
- Not run on the NAS CPU itself. Remux was ~0% CPU here, but check `speed=` in the player on the Marvell box.

## Multiple indexer sources (added later)

Search is now built on adapters (`src/sources/`): a Torznab adapter (BitMagnet, Jackett, NZBHydra2, single Prowlarr indexers) and a Prowlarr REST adapter, plus a search layer that queries every source in parallel with per-source timeouts, merges results and deduplicates by infohash.

- **Tests:** `npm test`, 23 tests with Node's built-in runner, all passing. Adapters receive `fetch` as a parameter and run against sanitized mock fixtures. The Jackett and Prowlarr fixtures are shaped after their documented response formats.
- **Integration check:** a source pointed at an unused test endpoint returned the expected connection error while the other mocked sources remained usable.
- **Not tested live:** Jackett and Prowlarr; neither runs on the network.
- **Found while researching:** Prowlarr rewrites both `magnetUrl` and `downloadUrl` into proxy links with its API key in plain text, and Jackett's `/dl/` links carry its key too. Such links now stay on the server: the browser gets a `linkId`, and the old `link` field that let a client make the server fetch any URL is gone. Prowlarr has no aggregate Torznab feed, hence the REST adapter. Prowlarr's `-2` means "all torrent indexers" (from `ReleaseSearchService`).

### Live test with Jackett and Prowlarr (compose stack)

`compose.yml` runs magplay with Jackett and Prowlarr. `tools/scripts/setup-indexers.mjs` now requires indexers to be passed explicitly. Results below are historical implementation notes using sanitized fixtures:

- **All three sources live:** an open-video fixture gave BitMagnet, Jackett and Prowlarr results that merged and deduplicated correctly.
- **Download proxies:** opening link-only results resolved through Jackett's `/dl/` (1 s) and Prowlarr's `/download` (under 1 s) to the correct torrents.
- **Fixed during the test:**
  - Jackett `all` results were labelled just "Jackett". They now name the configured source from `<jackettindexer>` or `<prowlarrindexer>`.
  - Link-only duplicates from different sources weren't merged, because each proxy link is different. They're now matched by title and size.
  - The compose network was given `172.30.0.0/24` (Docker fell back to it because 172.16–31 were all in use), which covered the LAN and made BitMagnet unreachable. It's now pinned to `10.89.82.0/24`.
- **Encoding edge case:** a source title came through Prowlarr as mojibake (UTF-8 read as Latin-1).
- **Tests:** 24, all passing.

## Downloads, torrent IDs and media notes (added later)

- **Downloads:** per-file links (`/raw/…?download=1`), **Download all (.tar)** (`/tar/<ih>`), and clickable magnet links. `/raw` and `/tar` share one sender with Range, `ETag` and `If-Range`. The tar is laid out up front from file sizes (PAX headers for long and Unicode names, paths stripped of `..`), so its length is known and any range can be produced.
- **Live test:** the 830 MB OpenContent pack as `.tar`, cut off after 15 s at 423 MB and resumed with `curl -C -` (HTTP 206). The archive was the exact size, listed all 7 files, and every extracted file was byte-identical to WebTorrent's hash-verified copy, including the one split by the resume. Remux playback and 1-byte ranges still work through the new `/raw` code.
- **Tests:** 34 passing. Tar archives are extracted with the system `tar` in the tests, and pass with both bsdtar (macOS) and GNU tar 1.34 (Debian, as in the image).
- **"You Can See Everything":** the top results were single 1.3–1.5 GB `.exe` files posing as a film. Results now say "Not a media file (.exe)" from the title, or "No media file found" once a torrent has been opened, instead of "likely plays directly". Torrents that are a single small video (a trailer) now count as video; previously the 100 MB sample filter hid them.

## Live torrent status (added later)

`GET /api/torrents/:ih/status` plus a panel in the file list: connected peers (address, client from the extended handshake, ↓/↑ speed, share of pieces, greyed out while choking us), totals, and a progress bar per file. Seeders that announce "have all" without a bitfield count as 100%. Checked live on the OpenContent pack while downloading E02: 11 peers (qBittorrent and Deluge), 5.8–12 MB/s, per-peer rates matching the total, and E02's bar growing from 10.4% to 12.3% in 6 s while E01 (cached) stayed full. The endpoint is read-only: polling it neither loads a torrent nor keeps it loaded.

## UI step 1: pages and URLs (added later)

From the UI plan: search, torrent and player are now separate pages with their own URLs (`/`, `/t/<ih>`, `/play/<ih>/<idx>`), sharing `public/lib/ui.js` and `public/lib/urls.js`; the server's `if` chain became a route table (`src/router.js`, with tests). Result titles are real links (focusable, middle-click works), and per-row ID and magnet buttons moved to the torrent page.

Checked in the browser at phone width: clicking a result far down the list opens the torrent page at once with a running "Finding peers… N s" counter; a dead torrent ends in "No peers found… try another release" with Try again; the loaded page has the infohash, downloads, activity and files as before; the player at `/play/…` is named "S01E01" and links back to its torrent by name; Back twice returns to all 40 results in 400 ms at the same scroll position (cached per tab for Back/Forward only); a link-only result opens via `/t?link=…` and switches to `/t/<infohash>`. Old `/player.html` links redirect.

## UI steps 2–4 (added later)

- **Step 2:** a `menu()` helper on `<details>`; the torrent page has one Play button, a More menu and a ⋯ menu per file, and activity is one line; the search page has source chips, an All/Movies/TV control and "plays in browser"; `/stats` merged into `/status`. Checked at phone width: menus open one at a time and close on Escape and outside clicks; a timed-out Prowlarr shows as a red chip.
- **Step 3:** messages on the video, an ⓘ Details panel, Open in menu, mute button, Next bar and a 10 s countdown. Checked: details rows filled from the live status; seeking to the end of E02 showed the countdown, Cancel stopped it, and letting it run moved to E03; a Hi10P H.264 fixture (no browser decodes it) showed the refusal card with Open in VLC, Copy stream link and Back to files, inside the video area.
- **Step 4:** recently opened torrents on the home page (`GET /api/recent`) and Continue on the torrent page from the last episode played in this browser. Checked: playing E04 stored it, and the torrent page then offered "Continue S01E04" and marked the row.
- **Not covered by automated tests:** the front end has no browser tests; it was checked by hand in the Chromium pane at phone width, not in Firefox or Safari this time.

## Explore (added later)

BitMagnet's GraphQL API (`/graphql`, `torrentContent.search`) drives `/explore`: content type, genre, year and resolution filters; sort by seeders or date; TMDB metadata per release. Jackett and Prowlarr only offer "latest" feeds without metadata, so they aren't used there; a title page links to a normal search across all sources.

- **Adapter:** `src/sources/bitmagnet.js` with `browse`, `facets`, `latest` and `title`; releases are grouped per TMDB title, the best release is the most-seeded one that plays in a browser. Tests use trimmed real responses (`test/fixtures/bitmagnet-*.json`).
- **Measured on the real index:** titles 0.06–0.9 s; facet counts for movies ~1.5 s but 9–26 s for TV (BitMagnet's aggregation), hence a separate, cached and pre-warmed facets call; Comedy + 1080p + 2024 by seeders took 17 s. The year filter must be sent as a string (BitMagnet's `Year` scalar).
- **Checked in the browser:** Movies (63 titles, 22 genre chips with counts, 41 years), TV (45 titles), title page for *Open Content Sample* (4 releases, metadata, IMDb/TMDB links), Best release → its torrent page with one video.
- **Fixes along the way:** OpenContent/OpenContent releases now count as H.264 with AAC ("plays in browser"); single-video torrents show "▶ Play" instead of the file name.
- **Adult content** is hidden by BitMagnet's own classification only (by choice, no name-based rules), so unrecognised adult releases can appear in "Just added".
