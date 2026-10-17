# magplay

Search a Torznab indexer (BitMagnet, Prowlarr…), pick a torrent, and play a video from it, either in the browser or in an external player such as VLC, IINA or Infuse. One small Node.js service, meant for a home NAS on a private network. It has no login.

For sample media to try it with, Blender’s [Open Movies](https://studio.blender.org/films/) such as Big Buck Bunny and [Elephants Dream](https://orange.blender.org/download/) are shared under Creative Commons.

```
browser ── /api/search ──────────────► sources in parallel: Torznab (BitMagnet, Jackett…), Prowlarr
        ── /api/torrents ────────────► WebTorrent (DHT + trackers) ──► /data/torrents
        ── /raw/:ih/:idx[/name] ─────► torrent file async iterator   (Range requests)
        ── /hls/:session/* ──────────► ffmpeg ◄── reads http://127.0.0.1/raw/:ih/:idx
VLC / IINA / Infuse ── /raw/… ───────┘
```

`/raw` is the single source of bytes. The browser uses it for direct play, ffmpeg and ffprobe read it as their input, and external players open it directly. WebTorrent fetches the pieces under each open stream first, so seeking only downloads what's needed.

See [docs/roadmap.md](docs/roadmap.md) for the current review, verification limits, architecture recommendations and prioritized next steps.

## Indexer sources

magplay searches every configured source in parallel, merges the results, and removes duplicates by infohash (keeping the highest seeder count and listing every source a result came from). A source that fails or takes longer than `SEARCH_TIMEOUT_S` doesn't block the rest: you get the other results and a note such as "Jackett timed out after 30 s".

| Source | Configure with | How magplay talks to it |
|---|---|---|
| **BitMagnet** | `TORZNAB_URL=http://bitmagnet:3333/torznab/api` | Torznab |
| **Jackett** | `JACKETT_URL=http://jackett:9117`, `JACKETT_APIKEY` | Torznab feed `/api/v2.0/indexers/<JACKETT_INDEXER>/results/torznab/api`. The default `all` searches every configured tracker. A filter such as `tag:tv,!type:private` also works. A full feed URL in `JACKETT_URL` is used as is. |
| **Prowlarr** | `PROWLARR_URL=http://prowlarr:9696`, `PROWLARR_APIKEY` | REST `/api/v1/search` across all torrent indexers (`PROWLARR_INDEXERS=-2`, or a list of indexer ids), with the key in an `X-Api-Key` header. Prowlarr has no combined Torznab feed. |
| **Any Torznab feed** (NZBHydra2, a single Prowlarr indexer at `/<id>/api`, …) | `TORZNAB_URL_2` … `TORZNAB_URL_9`, each with optional `TORZNAB_APIKEY_n` and `TORZNAB_NAME_n` | Torznab |

Searches always use free-text `t=search` (or `type=search`), never season/episode filters, which hide season packs.

Some results have no magnet or infohash, only a download link through the indexer's proxy (Jackett's `/dl/…`, Prowlarr's `/<id>/download…`). These links contain the indexer's API key in plain text, so they never go to the browser. The page gets an opaque `linkId`, and magplay fetches the link itself when you open the result: either a `.torrent` file or a redirect to a magnet. Ids are kept for the last 5,000 results and are lost on restart ("This search result has expired. Search again."). Prowlarr also rewrites raw magnets into proxy links, so when it reports an infohash magplay builds the magnet itself and skips the proxy.

Each kind of indexer is an adapter in `src/sources/` with one method, `search(query, { cat, signal })`, returning normalized releases. Adding another kind means writing an adapter and registering it in `src/sources/index.js`.

## Using it

Three pages, each with its own URL, so Back, reload, bookmarks and new tabs all work:

- **Search** (`/?q=…`). Results from every source, merged, with size, seeders, title badges and "plays in browser" for H.264 releases with AAC or unknown audio. Chips under the search show each source's result count; a failed source is red, with the reason on hover. All / Movies / TV searches again at once. With no search, the page lists **recently opened** torrents from the cache, with the last episode this browser played.
- **Explore** (`/explore`, needs BitMagnet). Films and shows from BitMagnet's TMDB-matched index, one tile per title (plain coloured tiles, no posters, nothing loaded from outside). Movies / TV, Most seeded / Newest, genre chips with counts, year and quality. A title page (`/title/…`) shows rating, runtime, genres, overview, IMDb/TMDB links and every release of that exact title in BitMagnet, browser-playable first, with **Best release** and **Search all sources**. "Just added" lists the newest releases, including ones BitMagnet couldn't match.
- **Torrent** (`/t/<infohash>`). Opens straight away and counts the seconds while magplay finds peers and the file list (up to `METADATA_TIMEOUT_S`). One **Play** button (or **Resume S01E04 at 12:34** where you left off), a **More** menu for the whole torrent (playlist of all episodes, Download all as `.tar`, open or copy the magnet, copy the infohash), and a row per file with ▶ and a ⋯ menu (external players, copy the stream link, download the file). One activity line (peers, speed, how much is on the NAS) opens into the peer table; each file has a progress bar.
- **Player** (`/play/<infohash>/<file>`). Messages appear on the video. Audio, subtitles, **Open in** (external players) and **ⓘ Details** (mode, codecs, peers, buffer, ffmpeg speed) sit below. A **Next** bar links to the next episode, and at the end of one the next starts after 10 s unless you cancel.

### Playing

Each video can be played these ways:

- **In the browser** (▶). magplay probes the file and picks a mode based on what this browser says it can decode (`MediaSource.isTypeSupported`, not the user agent):
  1. **direct**: MP4/WebM with codecs the browser supports. The browser reads `/raw` itself, and the NAS does no work.
  2. **remux**: the video codec is supported but the container (MKV…) or the audio (AC3, E-AC3, DTS, TrueHD…) isn't. ffmpeg copies the video into HLS (fMP4) and converts the audio to AAC stereo, which takes very little CPU.
  3. **transcode**: only with `ALLOW_VIDEO_TRANSCODE=true`. libx264 at `TRANSCODE_MAX_HEIGHT`. This is too slow for 1080p on the NAS CPU.
  4. Otherwise it **refuses** before streaming and explains why (for example HEVC in Firefox).
- **In an external player** (the ⋯ menu, or **Open in** in the player). These links open the same `/raw` URL in a player that decodes everything on the client: HEVC, 10-bit, AV1, DTS, TrueHD and image subtitles (PGS/VobSub), with all audio and subtitle tracks and no ffmpeg on the NAS. The links offered depend on the device:
  - `.m3u`: works with any player on any OS (the OS opens your default video player). For packs, **More → Play all (.m3u)** puts every episode in one playlist, so the next episode plays automatically.
  - **IINA** (macOS) `iina://weblink?url=…`, **Infuse** (macOS/iOS/tvOS) `infuse://x-callback-url/play?url=…`, **VLC** (iOS/Android) `vlc://…`, **Open with…** (Android) `intent://…#Intent;type=video/*;end`.
  - **Copy stream link** for "Open network stream".

  Links use the address your browser used to reach magplay, plus the file name (`/raw/<ih>/<idx>/Show.S01E01.mkv`), so players show a title. With an external player you lose the in-page status (peers, speed). On a slow torrent the player just buffers; raising VLC's network cache helps.

**Download.** Every file's ⋯ menu has **Download file**, and torrents with several files have **More → Download all (.tar)**, which streams every file as one tar archive. Both go through the same `/raw` path and support Range requests, so an interrupted browser download can resume. Tar needs no extra tools to open on macOS, Linux or Windows 11, and long or non-ASCII file names are kept (PAX headers). **More → Open in your torrent client** hands the magnet to your own client instead. The torrent page shows its infohash (**ID 5d0e004f…**), which copies the full ID when clicked.

**Torrent status.** While a torrent page is open, its activity line (updated every 2 s) opens into the connected peers (address, client, download and upload speed, how much of the torrent each one has; peers not currently sending are greyed out), the total speeds, how much of the torrent is on the NAS, and a progress bar under each file. It covers downloads and playback alike. A torrent magplay has unloaded after `IDLE_TORRENT_MIN` shows as not active.

Torrents whose title names a program or an archive (`.exe`, `.rar`…) get a plain note instead of "plays in browser". So does a torrent magplay has opened and found no video in ("No media file found"); later searches show the same note.

**Firefox/Zen** can't play HEVC, AC3, E-AC3 or DTS. Audio is converted cheaply, but HEVC is refused, so use an external player or pick an x264 release. **Safari** plays HEVC (remuxed and tagged `hvc1`). **Chrome** plays HEVC where the OS has a decoder.

**ⓘ Details** in the player shows the mode, codecs, peers, how much of the file is on the NAS, how much is buffered, and ffmpeg's speed (e.g. `85x`). If ffmpeg runs below 1.0x and playback catches up with it, a warning appears on the video. A file the browser can't play gets a card on the video with the first external player for your device, **Copy stream link** and **Back to files**. ffmpeg is paused once it is 4 minutes ahead of playback, so it doesn't fill the disk with segments nobody has watched yet. Seeking past what ffmpeg has produced restarts it at the new position (the seek bar uses the probed duration). Switching the audio track also restarts at the current position. Text subtitles (SRT/ASS/WebVTT inside the file, or `.srt`/`.vtt` files in the torrent) can be selected; image subtitles are listed but disabled.

If autoplay with sound is blocked (Firefox does this on a fresh tab), playback starts muted. Click the video or press **M** to unmute. Other keys: **space** to play/pause, **←/→** to seek 10 s.

## Setup (Docker Compose)

Save this as `compose.yml` and point `TORZNAB_URL` at your indexer:

```yaml
services:
  magplay:
    image: ghcr.io/kasparsd/magplay:edge   # or pin a release version
    restart: unless-stopped
    ports:
      - "3382:8080"
      - "6881:6881/tcp"   # torrent peers
      - "6881:6881/udp"   # DHT
    environment:
      TORZNAB_URL: "http://bitmagnet:3333/torznab/api"
      TORZNAB_NAME: "BitMagnet"
      # Optional, any combination:
      # JACKETT_URL: "http://jackett:9117"
      # JACKETT_APIKEY: "…"
      # PROWLARR_URL: "http://prowlarr:9696"
      # PROWLARR_APIKEY: "…"
      CACHE_MAX_GB: "50"
    volumes:
      - magplay_data:/data

volumes:
  magplay_data:
```

Start it:

```bash
docker compose up -d
```

Then open `http://example-host:3382/`. To build from a checkout instead of pulling the image, replace `image:` with `build: .`; the repository's own [compose.yml](compose.yml) does this and adds Jackett and Prowlarr (see [Trying it with Jackett and Prowlarr](#trying-it-with-jackett-and-prowlarr)). The image is `node:24-alpine` plus Alpine's `ffmpeg` (about 125 MB to download), builds for `linux/arm64` (and amd64), runs as `node`, and has a healthcheck on `GET /health`.

Prebuilt images are published to `ghcr.io/kasparsd/magplay`. Publishing a GitHub release `vX.Y.Z` tags the image `X.Y.Z`, `X.Y` and `X`; a prerelease (such as `vX.Y.Z-rc.1`) gets only its exact version. Every push to `main` moves the `edge` tag, and older edge builds are deleted. There is no `latest` tag, so pin a release or follow `edge` on purpose.

**Indexer addresses:** inside the container, use Compose service names (`http://bitmagnet:3333/...`, `http://jackett:9117`) or IP addresses. `.local` mDNS names such as `example-host.local` resolve on a Mac, and inside Docker Desktop, but usually **not** inside a Linux container, because the image has no mDNS resolver.

**Behind Nginx Proxy Manager:** turn off buffering for streams (Advanced tab: `proxy_buffering off;`). Otherwise nginx buffers `/raw` and `/hls` responses and seeking gets slow. Links in `.m3u` files honour `X-Forwarded-Proto`/`X-Forwarded-Host`.

## HTTP caching and reverse proxies

Successful GETs and HEADs use these policies (HEAD has no body). All errors, including
404-before-ready and 416, use `no-store`; redirects and mutations do too.

| Response class | Cache-Control | Validators / reason |
|---|---|---|
| HTML, CSS, JS, bundled HLS library | `no-cache` | Weak metadata ETag and Last-Modified; store, but revalidate on each use. URLs are unversioned. |
| Probe API summary | `private, no-cache` | Content ETag; stable media metadata, revalidated for software changes. |
| Raw torrent files and tar downloads | `private, max-age=3600, must-revalidate` | Strong content-identity ETag; one hour of browser reuse, then revalidate. Range/If-Range retained. |
| Completed `/subs/…` conversions | `private, no-cache` | Content ETag; revalidate generated output across releases. |
| Finalized HLS `.m4s` segments | `private, no-cache` | Weak metadata ETag and Last-Modified; atomically published by ffmpeg. Revalidation checks session existence after cleanup. |
| HLS playlists, progressive `.vtt`, startup `init.mp4` | `no-store` | May still be growing; always read origin. |
| Other APIs (search, Explore/title, torrent description, recent, status, health), `.m3u` playlists | `no-store` | Mutable state, expiring link IDs, keepalive side effects or forwarded-host-dependent links. Explore's existing in-process cache is separate from HTTP caching. |

Conditional GET/HEAD supports weak/list/wildcard `If-None-Match`, which takes precedence
over `If-Modified-Since`. A matching validator returns a bodyless 304. Raw/tar
preconditions run before Range; If-Range requires the exact strong ETag (weak or
mismatched validators cause a full response). HEAD ignores Range.
Large files remain streamed: media is not buffered or hashed per request.
`private` intentionally permits browser caching but not shared proxy caches, even
on a single-user NAS. Cached raw bytes may remain usable for an hour after origin
cache eviction; session media instead always revalidates.

A conservative Nginx configuration needs no disk proxy cache:

```nginx
location / {
    proxy_pass http://magplay:8080;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 3600s;
}
```

Respect origin Cache-Control/Expires; do not use `proxy_ignore_headers` or a blanket
`expires`/`immutable` rule. Do not cache POST/DELETE, live endpoints, redirects or
errors (including missing HLS files). Preserve ETag, Last-Modified, conditional
request headers, Range/If-Range, Accept-Ranges, Content-Range and Content-Disposition;
Nginx's default proxy header forwarding does this. Do not buffer media streams.
This example intentionally does not enable shared caching of any API/media.

For a same-origin static frontend, serve `public/` and the built `dist/client/`
bundles with `Cache-Control: no-cache`, ETag and Last-Modified; route page URLs to
their corresponding HTML and proxy API/media to Node. Deploy the frontend bundles
and backend together. Unversioned assets must
revalidate, not receive long fresh/immutable caching. Purge any pre-existing proxy
cache/overridden TTLs when changing this policy; a browser holding an older long-lived
response may need a hard reload/cache clear. No Node/proxy speedup has been benchmarked.

## Configuration

| Var | Default | Meaning |
|---|---|---|
| `PORT` | `8080` | HTTP port |
| `TORZNAB_URL` | — | Torznab feed. `TORZNAB_URL_2` … `_9` add more feeds. With no indexer env vars set, there are no sources and the server says so at startup. |
| `TORZNAB_APIKEY`, `TORZNAB_NAME` | empty, host name | API key (sent as `apikey=`) and display name; also `_2` … `_9` |
| `JACKETT_URL`, `JACKETT_APIKEY` | — | Jackett base URL and key |
| `JACKETT_INDEXER` | `all` | Jackett indexer id, `all`, or a filter expression |
| `PROWLARR_URL`, `PROWLARR_APIKEY` | — | Prowlarr base URL and key |
| `PROWLARR_INDEXERS` | `-2` | Comma-separated Prowlarr indexer ids; `-2` is every torrent indexer |
| `SEARCH_TIMEOUT_S` | `30` | Per-source search timeout (also Explore's) |
| `BITMAGNET_URL` | from `TORZNAB_URL` | BitMagnet's address, for Explore (its GraphQL API). Found automatically when a Torznab source is at BitMagnet's path `/torznab/api`; without BitMagnet, Explore says so. |
| `CACHE_DIR` | `./data` | Torrent data (`torrents/<infohash>/`) and HLS sessions (`hls/`). The Docker image overrides this to `/data`. |
| `CACHE_MAX_GB` | `50` | Least-recently-used torrent folders are deleted above this (checked every minute; torrents in use are kept) |
| `TORRENT_PORT` | `6881` | TCP (peers) and UDP (DHT). Publish both in Compose. |
| `EXTRA_TRACKERS` | opentrackr, stealth.si, torrent.eu.org, explodie.org, desync.com | Comma-separated, added to every torrent (BitMagnet magnets often have none) |
| `METADATA_TIMEOUT_S` | `60` | Give up fetching a torrent's file list after this |
| `IDLE_TORRENT_MIN` | `30` | Unload torrents nobody has streamed or watched for this long (data stays on disk) |
| `ALLOW_VIDEO_TRANSCODE` | `false` | Enable the libx264 path (slow on the NAS CPU) |
| `TRANSCODE_MAX_HEIGHT` | `720` | Downscale target when transcoding |
| `FFMPEG_PATH`, `FFPROBE_PATH` | `ffmpeg`, `ffprobe` | Paths to the binaries when they aren't on `PATH` |

Local safeguards reject excess jobs with a retryable 503 rather than an unbounded queue. See [resource limits](docs/resources.md), [player lifetime handling](docs/lifecycle.md), and [per-file Resume/Start over behavior](docs/progress.md). HLS disk limits are soft; use a filesystem/container quota for a hard bound.

`TORRENT_CHECK_TIMEOUT_S` (default `7200`) separately bounds cached-piece verification after metadata arrives. `DHT_ENABLED=false` and `LSD_ENABLED=false` disable those discovery mechanisms when using explicit trackers/peers; both default to enabled. See [loopback integration coverage](tests/integration/README.md) and [Docker/NAS acceptance](docs/deployment-acceptance.md).

## HTTP API

| Method + path | Does |
|---|---|
| `GET /`, `/t/:ih`, `/play/:ih/:idx` | The pages: search, a torrent's files and activity, the player. Every step has its own URL, so reload, Back, bookmarks and new tabs work. `/t?link=<linkId>` opens a link-only search result and switches to `/t/<infohash>` once resolved. Old `/player.html?ih=&idx=` links redirect. |
| `GET /api/explore?type=&genre=&year=&res=&sort=&page=` | A page of titles from BitMagnet: `{titles:[{type, source, id, title, year, rating, runtime, overview, genres, links, releaseCount, seeders, playable, best}], hasMore}`. `type` is `movie` or `tv_show`, `sort` is `seeders` or `added`. Cached 60 s. |
| `GET /api/explore/facets?type=&genre=&year=&res=` | Genre, year and resolution counts under those filters. Slow on a big index (tens of seconds for TV), so cached 15 min and warmed for both types at startup. |
| `GET /api/explore/latest?type=` | The newest releases, matched or not |
| `GET /api/title/:type/:source/:id?title=&year=` | A title's metadata and its releases in BitMagnet |
| `GET /api/recent` | Torrents with saved metadata in the cache, most recently used first: `[{infoHash, name, length, onDisk, lastUsed}]` |
| `GET /api/search?q=&cat=` | Searches all sources. Returns `{results: [{title, infoHash, magnet, linkId, size, seeders\|null, sources, badges, likelyDirect}], sources: [{name, ok, count, error, ms}]}`, with results sorted by seeders, then size. 502 only if every source fails. |
| `POST /api/torrents` `{infoHash \| magnet \| linkId}` | Adds or reuses the torrent, waits for metadata (504 after `METADATA_TIMEOUT_S`) and returns `{infoHash, name, files:[{idx, name, size, isVideo, isSub, season, episode}]}`. Nothing is downloaded until a file is streamed. `linkId` refers to a download link from a recent search (410 if it has expired). |
| `GET /api/torrents/:ih` | The same as `POST /api/torrents` with an infohash: loads the torrent if needed and returns its file list |
| `GET /api/torrents/:ih/status[?idx=&session=&pos=]` | Live view of a loaded torrent (never loads one): `{loaded, activeStreams, downloadSpeed, uploadSpeed, downloaded, length, progress, files:[{idx, progress}], peers:[{address, client, type, downloadSpeed, uploadSpeed, downloaded, uploaded, share, choking}]}`. The player adds `idx` for `file: {progress, ranges}` (which also keeps the torrent loaded) and `session`/`pos` for its ffmpeg session's `{speed, produced, paused, running, failed, error}` (which keeps the session alive). |
| `GET /raw/:ih/:idx[/:name][?download=1]` | The file, with `Range`, `ETag` and `If-Range` support. `download=1` adds `Content-Disposition: attachment`. |
| `GET /tar/:ih[/:name.tar]` | Every file in the torrent as one tar archive (PAX headers), with known length and Range support for resuming |
| `GET /playlist.m3u?ih=[&idx=]` | `.m3u` for external players: one file, or every video in the torrent |
| `GET /api/probe/:ih/:idx` | ffprobe summary: duration, container, video, audio and subtitle tracks, external subtitle files |
| `POST /api/play` `{ih, idx, audio, start, caps, tab}` | `{mode, reason, url, offset, duration, session, subtitles}`, or 422 with an explanation. Stops the tab's previous session. |
| `GET /hls/:session/:file` | Playlist, init segment, segments and `sub_N.vtt` |
| `DELETE` or `POST /api/play/:session` | Stops ffmpeg and deletes the session directory. `POST` is for `navigator.sendBeacon` when the tab closes. Sessions with no requests for 45 s are also stopped. |
| `POST /api/play/tab/:tab` | Closes a page activation, including a session whose POST result has not reached the browser yet; late requests for that activation are fenced briefly. |
| `GET /subs/:ih/:idx/:track.vtt` | Embedded text subtitle `track` as WebVTT (direct mode; reads the whole file), or `file.vtt` to convert a `.srt`/`.vtt`/`.ass` file in the torrent |
| `GET /health` | 200 |

## Dependencies

Four direct npm dependencies, all pinned to exact versions:

| Package | Version | Purpose | Maintainers |
|---|---|---|---|
| [`webtorrent`](https://github.com/webtorrent/webtorrent) | 3.0.21 | Torrent client (DHT, trackers, TCP) | WebTorrent project: Feross Aboukhadijeh, Mathias Buus, Diego Rodríguez Baquero, Alex (alxhotel) and others |
| [`parse-torrent`](https://github.com/webtorrent/parse-torrent) | 11.0.24 | Parse magnets and .torrent files (also used inside webtorrent) | WebTorrent project |
| [`fast-xml-parser`](https://github.com/NaturalIntelligence/fast-xml-parser) | 5.11.2 | Torznab XML | Amit Gupta (NaturalIntelligence) |
| [`hls.js`](https://github.com/video-dev/hls.js) | 1.7.3 | HLS playback in Firefox/Chrome, served from the container | video-dev: Rob Walch, Tom Jenkinson, Guillaume du Pontavice |

Plus `ffmpeg`/`ffprobe` from Alpine Linux.

WebTorrent pulls in about 180 transitive packages, mostly from the WebTorrent project (feross, mafintosh, jhiesey, ThaUnknown…) and common Node utilities. `npm ls --omit=dev --all` lists them all. One is worth knowing about: `node-datachannel` (Murat Doğan) is a native WebRTC module that WebTorrent loads at startup even though magplay doesn't use WebRTC. Its install script downloads a prebuilt binary during `npm ci`, which is why the Dockerfile runs install scripts. uTP is turned off (it would share the DHT's UDP port), so `utp-native` prints a harmless "Cannot find module" warning at startup on Linux.

## Known limits

- **No video transcoding by default.** The ARM CPU can't re-encode 1080p in real time. Use an external player for HEVC/10-bit in Firefox.
- **Seek accuracy in HLS modes:** ffmpeg starts at the keyframe before the requested time, so after a seek the clock can be a few seconds off.
- **Embedded subtitles in direct mode** (rare: MP4 with `mov_text`) require reading the whole file first. In remux mode they come from the same ffmpeg and appear as it goes.
- **Image subtitles** (PGS/VobSub) aren't shown in the browser. Use an external player.
- **Downloads fill the cache:** a download fetches the whole file or torrent into `CACHE_DIR`, and a torrent being downloaded is never evicted, so a torrent bigger than `CACHE_MAX_GB` pushes the cache over the limit until it's done.
- **Each new peer costs one piece:** WebTorrent downloads one random piece from each new peer to validate it, so a few MB arrive even before you play anything.
- **Restarting the container** clears HLS sessions; open players need to start again. Torrent data and metadata are kept, so the file list and cached files reload without peers.
- **Jackett and Prowlarr were tested live with public indexers only** (via the root `compose.yml`). Private trackers with cookies or Cloudflare protection weren't tried.
- **A slow tracker behind Jackett `all` or Prowlarr delays that whole source**, because they wait for all their indexers. magplay cuts the source off at `SEARCH_TIMEOUT_S` and shows the others.
- **Explore relies on BitMagnet's classification.** Releases it didn't match to TMDB have no metadata and only appear in "Just added". Adult content is hidden using BitMagnet's own classification (its `xxx` type and TMDB's adult flag), so adult releases BitMagnet didn't recognise can still show in "Just added". Facet counts for TV take tens of seconds the first time; combining several filters can take ~20 s.
- **No auth** by design. Only expose it on a private network (WireGuard).

## Trying it with Jackett and Prowlarr

`compose.yml` in this repo runs magplay together with Jackett (`linuxserver/jackett:v0.24.2663-ls38`) and Prowlarr (`linuxserver/prowlarr:2.6.5.5623-ls162`). It's for local testing.

```bash
echo "BITMAGNET_URL=http://example-host:3333/torznab/api" > .env
```

```bash
docker compose up -d --build
```

```bash
node tools/scripts/setup-indexers.mjs
```

The script adds only the indexers passed on the command line, reads API keys from `tools/docker/*/config/`, writes them to `.env`, and recreates magplay.

Override `MAGPLAY_PORT` and `TORRENT_PORT` in `.env` if those ports are taken. The stack's network is pinned to `10.89.82.0/24` (`DOCKER_SUBNET`): on a machine with many Docker networks, Docker had picked `172.30.0.0/24`, which covered the LAN, so BitMagnet became unreachable from inside the stack.

## Development

```bash
npm install
```

```bash
npm start                 # builds the client, then serves; cache lands in ./data; set TORZNAB_URL etc. to configure an indexer
```

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

- `apps/server/src/`: the Node service. Routes are one table in `server.js`, matched by `router.js`.
- `apps/client/src/`: one script per page (`search.js`, `torrent.js`, `player.js`, `explore.js`, `title.js`), plus `lib/ui.js` (DOM, formatting, `menu()`, copy buttons, tiles, release rows, per-browser memory), `lib/api.js` (DOM-independent JSON transport) and `lib/urls.js` (every URL the pages link to, including the external-player links). esbuild bundles each page, including `hls.js`, into `dist/client/` (`npm run build`); the server serves those bundles at the same URLs.
- `public/`: HTML and CSS, served as-is.
- `packages/`: `api-contract` (JSON wire types shared by server and client), `release-info` (file kinds, episode numbers, title badges) and `seekable-tar` (range-addressable tar streams).

### Test layout

Keep fast tests next to their modules as `*.test.js` or `*.test.ts`, for example `apps/server/src/router.test.js` and `packages/seekable-tar/src/index.test.ts`. `npm test` builds the client, then discovers these files under `apps/` and `packages/`, excluding helpers and browser integration tests. Run one file with `node --test apps/client/src/lib/api.test.js`. Cross-application Playwright tests live in `tests/e2e/*.test.js` and are selected separately by `playwright.config.js`.

Indexer adapters take `fetch` as a parameter and use recorded/synthetic responses in `apps/server/src/sources/test-fixtures/`, with shared helpers in `apps/server/src/sources/test-helpers.js`. The fast suite covers source parsing/configuration/errors/timeouts, deduplication, download-link resolution, episodes/badges, tar/ranges, media decisions, session lifecycle, HTTP caching and API-client transport. The Chromium suite exercises cached-torrent playback, seeking, audio switching, subtitles, retries, navigation and media cache policies. [docs/checkpoints/2026-10-17-build-report.md](docs/checkpoints/2026-10-17-build-report.md) retains historical live-swarm and device acceptance checks.

Docker excludes tests, fixture data and helpers from its build context, and the runtime image carries only the server, the packages, `public/` and the built bundles. Node serves the page bundles and their source maps through an explicit allowlist; client sources and colocated tests are never exposed.

### JSON API client

Import `api` from `apps/client/src/lib/api.js`; `ui.js` retains a compatibility re-export. The client keeps same-origin relative URLs, forwards fetch options/AbortSignal/cache settings, preserves caller headers when posting JSON, and never retries implicitly. HTTP errors expose `error.status` and the server's string error message (or `HTTP <status>` for a non-JSON proxy error). Invalid or empty JSON on a successful response now produces an explicit `Invalid JSON response` error instead of silently returning `{}`. Network, body-stream and abort failures retain their original error/reason. Use ordinary `fetch` for HEAD requests, text subtitles, playlists and media bytes.

`@magplay/api-contract` types probe results, browser capability keys, play requests, direct/HLS decisions and torrent/session status. They are compile-time contracts, not runtime response validation.

### Player helpers

`apps/client/src/lib/capabilities.js` measures codec support from explicitly supplied media/browser APIs, without user-agent assumptions or browser globals at import time. `apps/client/src/lib/subtitles.js` parses ffmpeg WebVTT snapshots, preserving cue text/timing and rejecting invalid timestamps. It is not a complete WebVTT renderer: the page still owns progressive-file handling, subtitle timeline offsets, polling and `VTTCue` creation. These helpers and `lib/progress.js` have colocated `*.test.js` coverage. Targeted page/request/timer ownership is implemented without a controller rewrite; further extraction is conditional on an actual maintenance need.

## License

[MIT](LICENSE)
