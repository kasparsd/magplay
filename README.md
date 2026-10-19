# magplay

Search a Torznab indexer (BitMagnet, Prowlarr…), pick a torrent, and play a
video from it, either in the browser or in an external player such as VLC, IINA
or Infuse. One small Node.js service, meant for a home server, homelab box or
desktop computer on a private network. It has no login.

![magplay search results on desktop and mobile](docs/screenshots/search.png)

![magplay playing Big Buck Bunny on desktop and mobile](docs/screenshots/player.png)

![magplay settings on desktop and mobile](docs/screenshots/settings.png)

![magplay status panel on desktop and mobile](docs/screenshots/status.png)

<sub>The player shows [Big Buck Bunny](https://peach.blender.org/) (© Blender Foundation, CC BY 3.0). To regenerate the screenshots, run `node tools/scripts/screenshots.mjs path/to/big_buck_bunny_720p_h264.mov`.</sub>

For sample media to try it with, Blender’s [Open Movies](https://studio.blender.org/films/) such as Big Buck Bunny and [Elephants Dream](https://orange.blender.org/download/) are shared under Creative Commons.

## What it does

- Searches every configured source in parallel and merges results, deduplicating
  by infohash.
- Opens a torrent and lists its files; nothing is downloaded until a file is
  streamed.
- Plays in the browser (direct / browser remux / remux / transcode) or hands
  a `/raw` link to an external player that decodes everything on the client.
- Runs without ffmpeg (the `magplay-core` image) on small hosts such as a
  router's container host: the browser repackages MKV and converts AC3/DTS
  audio itself.
- Downloads individual files or whole torrents as a tar archive, with resume.
- Keeps a cache with LRU eviction; torrents in use are never evicted.
- No login by design; only expose on a private network (WireGuard).

```
browser ── /api/search ──────────────► sources in parallel: Torznab (BitMagnet, Jackett…), Prowlarr
        ── /api/torrents ────────────► WebTorrent (DHT + trackers) ──► /data/torrents
        ── /raw/:ih/:idx[/name] ─────► torrent file async iterator   (Range requests)
        ── /hls/:session/* ──────────► ffmpeg ◄── reads http://127.0.0.1/raw/:ih/:idx
VLC / IINA / Infuse ── /raw/… ───────┘
```

`/raw` is the single source of bytes. The browser uses it for direct play and
browser remux, the probe and ffmpeg read it as their input, and external players
open it directly.
WebTorrent fetches the pieces under each open stream first, so seeking only
downloads what's needed.

See [docs/roadmap.md](docs/roadmap.md) for the current review, verification
limits, architecture recommendations and prioritized next steps.

Released changes are listed in [CHANGELOG.md](CHANGELOG.md), starting with the first release after `0.1.0`. [docs/releases.md](docs/releases.md) explains release notes and how a release is prepared.

## Quick start

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
      - /run/avahi-daemon:/run/avahi-daemon:ro   # optional: .local names in source URLs

volumes:
  magplay_data:
```

Start it:

```bash
docker compose up -d
```

Then open `http://example-host:3382/`. To build from a checkout instead of
pulling the image, replace `image:` with `build: .`; the repository's own
[compose.yml](compose.yml) does this and adds Jackett and Prowlarr (see
[Trying it with Jackett and Prowlarr](#trying-it-with-jackett-and-prowlarr)).
There are two images, built from the same Dockerfile and published to GHCR:

- **`ghcr.io/kasparsd/magplay`**: the one to start with. `node:24-alpine`
  plus Alpine's `ffmpeg` (libx264, AAC/AC3, VAAPI and Quick Sync hooks), about
  125 MB to download, for server-side remux, transcode and embedded subtitles.
- **`ghcr.io/kasparsd/magplay-core`**: the same server without ffmpeg, about a
  third smaller. It plays MP4/WebM directly, repackages MKV and converts
  AC3/E-AC3/DTS audio **in the browser**, converts `.srt` subtitle files
  itself, and hands everything else to an external player. Nothing is
  transcoded, and subtitles embedded in MKV need the full image. Meant for
  small hosts such as MikroTik RouterOS containers, where ffmpeg would not fit
  or run well. `magplay` is `magplay-core` plus the ffmpeg layer, so both
  behave identically apart from what ffmpeg adds.

Both build for `linux/arm64` and `linux/amd64`, run as `node`, and have a
healthcheck on `GET /health`. From a checkout, `docker build .` builds the full
image and `docker build --target core .` the core one.

Publishing a GitHub release `vX.Y.Z` tags both images `X.Y.Z`, `X.Y` and `X`;
a prerelease (such as `vX.Y.Z-rc.1`) gets only its exact version. Every push to
`main` moves the `edge` tag, and older edge builds are deleted. There is no
`latest` tag, so pin a release or follow `edge` on purpose.

## First search and playback

Each page has its own URL, so Back, reload, bookmarks and new tabs all work.

- **Search** (`/?q=…`). Paste a magnet link to look up that torrent directly,
  without a configured indexer, or enter text to search every source.
- **Torrent** (`/t/<infohash>`). Opens straight away and counts the seconds
  while magplay finds peers and the file list (up to `METADATA_TIMEOUT_S`). For
  torrents with videos, one **Play** button (or **Resume S01E04 at 12:34**
  where you left off), plus per-file rows.
- **Player** (`/play/<infohash>/<file>`). Messages appear on the video; Audio,
  subtitles, **Open in** (external players) and **ⓘ Details** sit below. A
  **Next** bar links to the next episode, and at the end of one the next starts
  after 10 s unless you cancel.

During a playback wait, **Torrent → Server → Prepare → Player** shows where work
is happening; select a stage to inspect its measured progress or open
**Diagnostics** for the full explanation.

## Configuration

### Indexer sources

magplay searches every configured source in parallel, merges the results, and
deduplicates by infohash, keeping the highest seeder count and listing every
source a result came from. A source that fails or takes longer than
`SEARCH_TIMEOUT_S` doesn't block the rest: you get the other results and a note
such as "Jackett timed out after 30 s".

| Source | Env vars | Protocol |
|---|---|---|
| **BitMagnet** | `TORZNAB_URL` | Torznab |
| **Jackett** | `JACKETT_URL`, `JACKETT_APIKEY`, `JACKETT_INDEXER` | Torznab |
| **Prowlarr** | `PROWLARR_URL`, `PROWLARR_APIKEY`, `PROWLARR_INDEXERS` | REST |
| **Any Torznab feed** | `TORZNAB_URL_2` … `TORZNAB_URL_9`, `TORZNAB_APIKEY_n`, `TORZNAB_NAME_n` | Torznab |

Sources can also be added in **Settings**.

- **BitMagnet**: for example `TORZNAB_URL=http://bitmagnet:3333/torznab/api`.
- **Jackett**: for example `JACKETT_URL=http://jackett:9117`. magplay reads the
  feed at `/api/v2.0/indexers/<JACKETT_INDEXER>/results/torznab/api`. The
  default indexer `all` searches every configured tracker, and a filter such as
  `tag:tv,!type:private` also works. A full feed URL in `JACKETT_URL` is used
  as is.
- **Prowlarr**: for example `PROWLARR_URL=http://prowlarr:9696`. magplay calls
  `/api/v1/search` across all torrent indexers (`PROWLARR_INDEXERS=-2`, or a
  list of indexer ids) and sends the key in an `X-Api-Key` header. Prowlarr has
  no combined Torznab feed.
- **Any Torznab feed**: NZBHydra2, a single Prowlarr indexer at `/<id>/api`,
  and so on.

Searches always use free-text `t=search` (or `type=search`), never season/episode
filters, which hide season packs.

Some results have no magnet or infohash, only a download link through the
indexer's proxy. These links contain the indexer's API key in plain text, so
they never go to the browser. The page gets an opaque `linkId`, and magplay
fetches the link itself when you open the result. Ids are kept for the last
5,000 results and are lost on restart ("This search result has expired. Search
again."). Prowlarr also rewrites raw magnets into proxy links, so when it
reports an infohash magplay builds the magnet itself and skips the proxy.

Each kind of indexer is an adapter in `packages/indexers/src/` implementing the
`Source` interface. Adding another kind means writing an adapter with a parse
function for its responses, adding its config to the `SourceConfig` union in
`sources.ts`, and reading it from env in `apps/server/src/config.ts`.

### Settings page

Open **Settings** from the gear at the right of the top bar (`/settings`). It
edits sources, playback and storage limits, saved to `settings.json` in the data
folder (`CACHE_DIR`, `./data` by default), and they apply without a restart. The
rest of the variables (ports, cache folder, job limits, timeouts, trackers,
ffmpeg paths, DHT and LSD) are set only in the environment. The status button
next to the gear shows whether sources, Explore, ffmpeg and the disk are
healthy.

Env vars still work and win over saved settings: a field set by one is read-only
in Settings and names its variable. magplay never writes `.env`. Sources from
env vars are listed first and locked; sources added in Settings follow them.

### Environment variables

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
| `LOG_LEVEL` | `info` | Structured stdout/Debug capture level: `debug`, `info`, `warn`, `error`, `silent`; restart required |
| `METRICS_ENABLED` | `false` | Enable the separate private Prometheus listener |
| `METRICS_HOST`, `METRICS_PORT` | `127.0.0.1`, `9091` | Management bind address/port; explicit internal-network bind needed for a container scraper |
| `CACHE_DIR` | `./data` | Torrent data (`torrents/<infohash>/`) and HLS sessions (`hls/`). The Docker image overrides this to `/data`. |
| `CACHE_MAX_GB` | `50` | Least-recently-used torrent folders are deleted above this (checked every minute; torrents in use are kept) |
| `TORRENT_PORT` | `6881` | TCP (peers) and UDP (DHT). Publish both in Compose. |
| `EXTRA_TRACKERS` | opentrackr, stealth.si, torrent.eu.org, explodie.org, desync.com | Comma-separated, added to every torrent (BitMagnet magnets often have none) |
| `METADATA_TIMEOUT_S` | `60` | Give up fetching a torrent's file list after this |
| `IDLE_TORRENT_MIN` | `30` | Unload torrents nobody has streamed or watched for this long (data stays on disk) |
| `SEEDING_ENABLED` | `true` | Keep sharing a loaded torrent once all its data is downloaded. Playback keeps priority; needs a reachable `TORRENT_PORT`. |
| `SEEDING_RATIO` | `1` | Stop sharing after uploading this multiple of the torrent's size: `0.5`, `1`, `2` or `5` |
| `ALLOW_VIDEO_TRANSCODE` | `false` | Enable the libx264 path (slow on the server CPU) |
| `TRANSCODE_MAX_HEIGHT` | `720` | Downscale target when transcoding |
| `TRANSCODE_ENCODER` | `auto` | Encoder: `auto`, `libx264`, or `h264_nvenc`/`h264_vaapi`/`h264_videotoolbox`/`h264_qsv`. Hardware choices fall back to libx264 unless a startup probe succeeds. |
| `VAAPI_DEVICE` | `/dev/dri/renderD128` | VAAPI render device |
| `FFMPEG_PATH` | `ffmpeg` | Path to the binary when it isn't on `PATH`. When ffmpeg doesn't run, the server starts anyway as the core image does (a status warning), without remux, transcode or embedded subtitles. |

Local safeguards reject excess jobs with a retryable 503 rather than an unbounded
queue. See [resource limits](docs/resources.md), [player lifetime handling](docs/lifecycle.md), and [per-file Resume/Start over behavior](docs/progress.md). HLS disk limits are soft; use a filesystem/container quota for a hard bound.

`TORRENT_CHECK_TIMEOUT_S` (default `7200`) separately bounds cached-piece
verification after metadata arrives. `DHT_ENABLED=false` and `LSD_ENABLED=false`
disable those discovery mechanisms when using explicit trackers/peers; both
default to enabled. See [loopback integration coverage](tests/integration/README.md) and [Docker/server acceptance](docs/deployment-acceptance.md).

Logs are structured JSON on stdout and in Settings → Debug, with linked
request/playback/job IDs and secrets removed. The Debug filter changes display
only; `LOG_LEVEL` controls capture. The bundled Compose service rotates local
logs and uses bounded non-blocking delivery. Inspect with
`docker compose logs --since 10m --no-log-prefix magplay`. Metrics are disabled
by default and are never served on the browser port. See
[logging and observability](docs/logging.md) for the metrics/scrape setup,
limits and collection contract.

## Playback

During a playback wait, **Torrent → Server → Prepare → Player** shows where work
is happening. Select a stage to inspect its measured progress or open
**Diagnostics** for the full explanation. A check means ready for playback;
downloads or conversion may still be running. **More → Playback flow** pins the
view while watching, and **Hide flow** closes it.

Each video can be played these ways:

- **In the browser** (▶). magplay reads the file's headers in Node (no
  ffprobe) and picks a mode based on what this browser says it can decode
  (`MediaSource.isTypeSupported`, not the user agent):
  1. **direct**: MP4/WebM with codecs the browser supports. The browser reads
     `/raw` itself, and the server does no work.
  2. **remux**: the video codec is supported but the container (MKV…) or the
     audio (AC3, E-AC3, DTS, TrueHD…) isn't. ffmpeg copies the video into HLS
     (fMP4) and converts the audio to AAC stereo, which takes very little CPU.
  3. **browser remux**: the same, on a server without ffmpeg (`magplay-core`). The browser
     reads `/raw`, copies the video and converts the audio to AAC itself
     ([Mediabunny](https://mediabunny.dev/) with WebCodecs and small WASM
     decoders for AC3/DTS), a minute ahead of playback. The timeline is the
     whole file, so seeking and switching audio need no server round trip.
  4. **transcode**: only with `ALLOW_VIDEO_TRANSCODE=true` and ffmpeg. libx264 at
     `TRANSCODE_MAX_HEIGHT`. This is too slow for 1080p on the server CPU. Hardware H.264 encoders are used when available, otherwise CPU.
  5. Otherwise it **refuses** before streaming and explains why (for example
     HEVC in Firefox, or a file that needs converting on a server without
     ffmpeg).
- **In an external player** (the ⋯ menu, or **Open in** in the player). These
  links open the same `/raw` URL in a player that decodes everything on the
  client: HEVC, 10-bit, AV1, DTS, TrueHD and image subtitles (PGS/VobSub),
  with all audio and subtitle tracks and no ffmpeg on the server. The links
  offered depend on the device:
  - `.m3u`: works with any player on any OS (the OS opens your default video
    player). For packs, **More → Play all (.m3u)** puts every episode in one
    playlist, so the next episode plays automatically.
  - **IINA** (macOS) `iina://weblink?url=…`, **Infuse** (macOS/iOS/tvOS)
    `infuse://x-callback-url/play?url=…`, **VLC** (iOS/Android) `vlc://…`,
    **Open with…** (Android) `intent://…#Intent;type=video/*;end`.
  - **Copy stream link** for "Open network stream".

  Links use the address your browser used to reach magplay, plus the file name
  (`/raw/<ih>/<idx>/Show.S01E01.mkv`), so players show a title. With an
  external player you lose the in-page status (peers, speed). On a slow torrent
  the player just buffers; raising VLC's network cache helps.

**Download.** Every file's ⋯ menu has **Download file**, and torrents with
several files have **More → Download all (.tar)**, which streams every file as
one tar archive. Both go through the same `/raw` path and support Range
requests, so an interrupted browser download can resume. Tar needs no extra
tools to open on macOS, Linux or Windows 11, and long or non-ASCII file names
are kept (PAX headers). **More → Open in your torrent client** hands the
magnet to your own client instead. The torrent page shows its infohash (**ID
5d0e004f…**), which copies the full ID when clicked.

**Firefox/Zen** can't play HEVC, AC3, E-AC3 or DTS. Audio is converted
cheaply, but HEVC is refused, so use an external player or pick an x264
release. **Safari** plays HEVC (remuxed and tagged `hvc1`). **Chrome** plays
HEVC where the OS has a decoder.

**ⓘ Details** in the player shows the mode, codecs, peers, how much of the file
is on the server, how much is buffered, and ffmpeg's speed (e.g. `85x`). If
ffmpeg runs below 1.0x and playback catches up with it, a warning appears on
the video. A file the browser can't play gets a card on the video with the
first external player for your device, **Copy stream link** and **Back to
files**. ffmpeg is paused once it is 4 minutes ahead of playback. Seeking past
what ffmpeg has produced restarts it at the new position (the seek bar uses the
probed duration). Switching the audio track also restarts at the current
position. Text subtitles (SRT/ASS/WebVTT inside the file, or `.srt`/`.vtt`
files in the torrent) can be selected; image subtitles are listed but disabled.

If autoplay with sound is blocked (Firefox does this on a fresh tab), playback
starts muted. Click the video or press **M** to unmute. Other keys: **space**
to play/pause, **←/→** to seek 10 s.

**Torrent status.** While a torrent page is open, its activity line (updated
every 2 s) opens into the connected peers (address, client, download and upload
speed, how much of the torrent each one has; peers not currently sending are
greyed out), the total speeds, how much of the torrent is on the server, and a
progress bar under each file. It covers downloads and playback alike. A torrent
magplay has unloaded after `IDLE_TORRENT_MIN` shows as not active.

Torrents whose title names a program or an archive (`.exe`, `.rar`…) get a
neutral download note instead of "plays in browser". Once magplay has opened a
torrent and found no video, later searches label it "Download only · no video
files". Audio, books, disk images and other non-video files remain
downloadable; browser audio-only playback is not implemented.

## Known limits

- **No video transcoding by default.** The ARM CPU can't re-encode 1080p in
  real time. Use an external player for HEVC/10-bit in Firefox.
- **Seek accuracy in HLS modes:** ffmpeg starts at the keyframe before the
  requested time, so after a seek the clock can be a few seconds off.
- **Embedded subtitles in direct mode** (rare: MP4 with `mov_text`) require
  reading the whole file first. In remux mode they come from the same ffmpeg
  and appear as it goes.
- **Image subtitles** (PGS/VobSub) aren't shown in the browser. Use an
  external player.
- **Downloads fill the cache:** a download fetches the whole file or torrent
  into `CACHE_DIR`, and a torrent being downloaded is never evicted, so a
  torrent bigger than `CACHE_MAX_GB` pushes the cache over the limit until it's
  done.
- **Each new peer costs one piece:** WebTorrent downloads one random piece from
  each new peer to validate it, so a few MB arrive even before you play
  anything.
- **Restarting the container** clears HLS sessions; open players need to start
  again. Torrent data and metadata are kept, so the file list and cached files
  reload without peers.
- **Jackett and Prowlarr were tested live with public indexers only** (via the
  root `compose.yml`). Private trackers with cookies or Cloudflare protection
  weren't tried.
- **A slow tracker behind Jackett `all` or Prowlarr delays that whole source**,
  because they wait for all their indexers. magplay cuts the source off at
  `SEARCH_TIMEOUT_S` and shows the others.
- **Explore relies on BitMagnet's classification.** Releases it didn't match to
  TMDB have no metadata and only appear in "Just added". The **Show adult
  content in Explore** setting defaults to off and applies to Explore/title
  pages only; source search results are not filtered. Adult Explore content is
  hidden using BitMagnet's own classification. Facet counts for TV take tens of
  seconds the first time; combining several filters can take ~20 s.
- **No auth** by design. Only expose it on a private network (WireGuard).

## Troubleshooting

**Indexer addresses:** inside the container, use Compose service names
(`http://bitmagnet:3333/...`, `http://jackett:9117`), IP addresses, or `.local`
mDNS names such as `example-host.local`. mDNS multicast doesn't reach a
container on Docker's bridge network, so magplay asks the host's avahi-daemon
instead: install it on the host (`apt install avahi-daemon`; many Linux systems
already run it) and mount its socket directory with
`- /run/avahi-daemon:/run/avahi-daemon:ro` under `volumes:`. The log says
`Resolving .local names through the host’s avahi-daemon` at startup when the
socket is there. Without it, `.local` names fall through to normal DNS, which
works in Docker Desktop but usually not on Linux.

**Behind Nginx Proxy Manager:** turn off buffering for streams (Advanced tab:
`proxy_buffering off;`). Otherwise nginx buffers `/raw` and `/hls` responses and
seeking gets slow. Links in `.m3u` files honour
`X-Forwarded-Proto`/`X-Forwarded-Host`. For the full caching/proxy policy see
[docs/http-caching.md](docs/http-caching.md).

**VPN:** magplay makes torrent connections from the server. An optional
[Gluetun deployment](docs/vpn.md) routes its public torrent traffic through a
VPN while keeping the web UI accessible locally. See the
[VPN guide](docs/vpn.md) for both scenarios (BitMagnet on another LAN host vs.
sharing Gluetun), port forwarding and disconnect checks. A standalone
[Compose example](tools/docker/compose.vpn.yml) covers the LAN-host scenario.

**macOS local-network permission:** if startup succeeds but source requests or
Explore count warming fail with `EHOSTUNREACH`, check **System Settings →
Privacy & Security → Local Network**. Enable access for the app hosting your
terminal, then quit and reopen that app and run `npm start` again. Allow
local-network access if macOS prompts. See
[Apple's local-network permission guide](https://support.apple.com/guide/mac-help/mchla4f49138/mac).

Check connectivity from the same terminal:

```bash
node -e 'fetch("http://bitmagnet.local:3333/torznab/api?t=caps", { signal: AbortSignal.timeout(5000) }).then(r => console.log(r.status)).catch(console.error)'
```

`200` confirms an HTTP response; `401`/`403` means reachable but requires
auth. If `EHOSTUNREACH` persists after allowing access, check host address, LAN
connection, VPN routing and firewall.

## Operating

**Cache eviction:** least-recently-used torrent folders are deleted above
`CACHE_MAX_GB` (checked every minute; torrents in use are kept). Downloads fetch
the whole file/torrent into `CACHE_DIR`.

**Logs:** structured JSON on stdout and in Settings → Debug, with linked
request/playback/job IDs and secrets removed. The Debug filter changes display
only; `LOG_LEVEL` controls capture. The bundled Compose service rotates local
logs and uses bounded non-blocking delivery. Inspect with
`docker compose logs --since 10m --no-log-prefix magplay`.

**Metrics:** disabled by default and never served on the browser port. See
[logging and observability](docs/logging.md) for the metrics/scrape setup,
limits and collection contract.

**Optional local observability stack:** the repository Compose file has an
opt-in `observability` profile with Prometheus, Loki, Alloy and Grafana. It
starts Grafana only on `127.0.0.1:3000`; metrics and backends remain on an
internal Docker network. Start it with
`docker compose --profile observability up -d --build`, then open
`http://127.0.0.1:3000`. Alloy reads the Docker socket to discover this
Compose project's magplay container (highly privileged; use only on a trusted
development machine). Stop just the backends with
`docker compose stop grafana alloy loki prometheus`; their named volumes retain
bounded history; `docker compose down --volumes` removes the whole development
stack and its magplay cache. Full limits and the isolated-stack validation
command are in [logging and observability](docs/logging.md#local-use).

**HTTP API:** full reference in [docs/api.md](docs/api.md). **HTTP caching
policy:** [docs/http-caching.md](docs/http-caching.md).

## Advanced

- [VPN guide](docs/vpn.md) and [compose.vpn.yml](tools/docker/compose.vpn.yml).
- [Deployment acceptance](docs/deployment-acceptance.md).
- [Resource limits](docs/resources.md), [lifecycle](docs/lifecycle.md),
  [progress](docs/progress.md).

## Development

```bash
npm install
npm start                 # builds the client, then serves; cache lands in ./data
npm run dev               # rebuilds the client and restarts the server on change
npm run typecheck         # tsc -b over every workspace
npm run lint              # ESLint (neostandard + type-aware rules), no warnings allowed
npm run release -- note --patch -m "..."   # add a release note (see docs/releases.md)
npm run release -- status --since origin/main   # what CI checks on a pull request
npm test                    # Fast Node regression tests
npx playwright install chromium
npm run test:e2e             # Generated local media + real Chromium playback
npm run test:peers           # Real loopback TCP transfer/failure cases
npm run test:all             # Fast + peer + browser suites
```

Playback tests need `ffmpeg` on `PATH`, with libx264, AAC and AC3 encoders
(the fixtures are generated with it; one e2e file then runs the server with
`FFMPEG_PATH` pointing nowhere to cover the core image). See [tests/e2e/README.md](tests/e2e/README.md) for coverage,
debugging and limitations.

Node 24+, ES modules, npm workspaces. The server and packages use strict
TypeScript. Architecture: [docs/architecture.md](docs/architecture.md).

- `apps/server/src/`: the Node service.
- `apps/client/src/`: one script per page plus `lib/`.
- `public/`: HTML and CSS.
- `packages/`: api-contract, release-info, indexers, torrent-engine, playback,
  seekable-tar, http-kit, observability.

Keep fast tests next to their modules as `*.test.js` or `*.test.ts`. Indexer
adapters take `fetch` as a parameter and use recorded/synthetic responses in
`packages/indexers/src/test-fixtures/`. Docker excludes tests, fixture data and
helpers from its build context.

`@magplay/api-contract` types probe results, browser capability keys, play
requests, direct/HLS decisions, torrent/session status, search results, torrent
file lists and Explore responses. See [docs/api.md](docs/api.md) for the HTTP
surface.

Dependencies: [docs/dependencies.md](docs/dependencies.md).

## Local testing stack (contributors)

`compose.yml` in this repo runs magplay together with Jackett
(`linuxserver/jackett:v0.24.2663-ls38`) and Prowlarr
(`linuxserver/prowlarr:2.6.5.5623-ls162`). This is for developing and testing
magplay itself; regular users point magplay at their own Jackett/Prowlarr via
env vars or Settings and do not need this stack or the script below.

```bash
echo "BITMAGNET_URL=http://example-host:3333/torznab/api" > .env
```

```bash
docker compose up -d --build
```

```bash
node tools/scripts/setup-indexers.mjs
```

The script adds only the indexers passed on the command line, reads API keys
from `tools/docker/*/config/`, writes them to `.env`, and recreates magplay.

Override `MAGPLAY_PORT` and `TORRENT_PORT` in `.env` if those ports are taken.
The stack's network is pinned to `10.89.82.0/24` (`DOCKER_SUBNET`).

For hardware transcoding in Docker, set `TRANSCODE_ENCODER` (for example `h264_vaapi`) and uncomment the `devices:` block in `compose.yml` so `/dev/dri` is passed through. Passing `/dev/dri` is not enough on its own: the published image's ffmpeg includes VAAPI and Quick Sync support, but the image includes neither VAAPI driver libraries nor the Intel oneVPL GPU runtime. NVENC is not compiled into its ffmpeg, and VideoToolbox does not exist on Linux. At startup and encoder refreshes, magplay tests each compiled hardware encoder with a one-frame encode; `auto` therefore uses libx264 in the stock image unless one of those probes succeeds.


## License

[MIT](LICENSE)