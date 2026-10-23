# magplay

## 0.4.1

### Patch

- Seeking works again in a file that plays from a growing playlist when its duration can't be read in advance.
- `@magplay/playback` 0.2.1: Videos with 5.1 or other multichannel audio play on iPhones and other browsers without Media Source Extensions when the server has no ffmpeg, instead of never starting. If that conversion ever stops producing video, playback now fails with an error instead of waiting forever.
- Videos with 5.1 audio start sooner (about 5 seconds less video to download first) when the browser repackages them itself (a server without ffmpeg).
- `@magplay/torrent-engine` 0.0.1: Each torrent keeps 2 pieces in memory after a read instead of 20, so a watched torrent no longer holds 70–300 MiB of its pieces afterwards.
- If a reverse proxy serves dist/client/assets itself, give files without a hash in their name (search.js, style.css) no-cache instead of immutable; see docs/http-caching.md. Hashed chunks stay immutable.
- The Docker images cap the Node heap at 128 MiB, so the server stays inside a small container's memory limit without extra settings. Set NODE_OPTIONS to change it.
- Returning to a torrent or title after playback keeps the link back to your results or Explore filters. Settings locks editing while a save is in progress and picks up changes made elsewhere when you return to the tab, keeping unsaved edits. Picture in picture is hidden for videos that forbid it, and the search box no longer takes focus when Back returns to results.
- `@magplay/playback` 0.2.1: A server without ffmpeg uses about 100 MiB less memory while it converts a video for playback.

## 0.4.0

### Minor

- `@magplay/api-contract` 0.2.0, `@magplay/playback` 0.2.0: Seeking in a remuxed or converted video is now an ordinary seek. The player gets one playlist for the whole file, the server converts whatever part you jump to, and parts already converted play straight away when you seek back. Subtitles and the seek bar stay in step after seeks and audio switches. Files without a keyframe index (MPEG-TS, AVI) play from the start and can be seeked as far as conversion has reached.

## 0.3.0

### Minor

- `@magplay/api-contract` 0.1.0, `@magplay/client` 0.1.0, `@magplay/playback` 0.1.0: magplay runs without ffmpeg. Next to `ghcr.io/kasparsd/magplay` (unchanged: with ffmpeg) there is now `ghcr.io/kasparsd/magplay-core`, which has no ffmpeg: MP4/WebM play directly, MKV and AC3/E-AC3/DTS audio are repackaged in the browser (new `browser-remux` mode, whole-file timeline, seeking and audio switching without the server), `.srt`/`.vtt` files in the torrent still work, and anything that needs converting opens in an external player. A browser that cannot repackage a file itself (no Media Source Extensions) gets that repackaging done in Node and plays the result as HLS. Files are probed in Node instead of ffprobe, so `FFPROBE_PATH` is gone and ffprobe is no longer needed anywhere. On the full image a missing or broken ffmpeg is now a status warning instead of a failed start, and the transcode settings are disabled while it is missing. Container names in Details and the probe API are now short ids (`mp4`, `matroska`, `webm`).

### Patch

- The container images are smaller to download: about 40 MB without ffmpeg and about 90 MB with it.

## 0.2.1

### Patch

- Docker transcoding falls back to libx264 when hardware encoders cannot run.

## 0.2.0

### Minor

- Show honest title-based playback estimates: likely direct, likely remux, or needs transcode. Best release now favors the lowest estimated video effort without claiming that a title proves browser support.
- Add hardware-accelerated H.264 transcoding with CPU fallback.
- Broaden discovery filters beyond movies and TV: Explore now accepts every BitMagnet content type (music, audiobooks, ebooks, comics, games, software, and the rest), and search adds Audio, Software, Books and Other categories alongside Movies and TV.
- The player shows a stable Torrent → Server → Prepare → Player flow during playback waits, with measured progress and a selectable stage inspector. Pin Playback flow from More to keep diagnostics visible while watching.
- Completed downloads are shared until they have uploaded their own size. Watching keeps priority over uploads, and sharing can be turned off.
- Settings drops 'Preferred subtitles', 'Preferred audio' and 'Default speed': the Player already remembers every track and speed choice from its own menus, which was all those controls mirrored. Choices made earlier keep applying.

### Patch

- Remove the Settings section menu while keeping direct links to each section.
- Startup logs and Debug report the application version from the server's manifest, which releases now bump. Changes are recorded in the repository changelog from this release on.
- Settings shows the environment label beside the source name and renders an empty API key as an input, including for read-only environment sources.
- Move the connection speed test into Debug and remove the separate Connection section from Settings.
- Show Debug server details and resource metrics as label-value rows instead of a grid of tiles.
- Stop caching the resolved asset-link map in memory, so pages always use the current build's hashed CSS and script URLs.
- Update source headings as URLs change, report connection limits without guessing the cause, and keep save confirmations accurate when returning to the page.
- Audio no longer runs ahead of video in converted (HLS) playback in Chrome and Firefox, most noticeably after resuming or seeking to a position. Playback resumed mid-scene now begins at the preceding keyframe with sound, instead of silent video before the audio joins.
- Defer hls.js playback until the manifest is parsed, so HLS streams (especially on slower or incomplete torrents) actually start instead of stalling after the playlist becomes ready. Also make Space/Spacebar reliably toggle play/pause across browsers.
- Settings marks fields that can be left empty — an indexer's API key, its indexer filter, the BitMagnet address — as "(optional)" next to their labels, and the API key field says when one is actually needed (Jackett and Prowlarr; plain Torznab feeds usually don't).
- Remove device-scope notes from Settings and keep section descriptions focused on their contents.
- Scripts and the stylesheet are now served under content-hashed `/assets/…` URLs that caches may keep for good, and pages always revalidate, so a new release shows up on reload even behind a caching reverse proxy. Purge any proxy cache stored with an overridden TTL once after upgrading.
- The Player page now has the status button and Settings gear in its top bar, like every other page.
- Restructure README around end-user goals; move HTTP API, caching policy, and dependency tables to docs.
- Remux non-faststart MP4s instead of playing them directly, so playback can start before the file's trailing metadata atom arrives.
- Fix a large empty box in the Settings Playback heading: its status slot shared the player wait-overlay's element id, so the global stylesheet gave it the overlay's huge padding.
- Use clearer labels and help text in Settings for source URLs, video conversion and disk limits.
- Show source status as a colored dot and plain text instead of a bordered badge, making it distinct from the Test button.
- Reuse cached torrent data when reopening a previously viewed torrent: save file mtimes after the first load and pass them back on reload so WebTorrent trusts the cached pieces instead of re-hashing or re-fetching them from peers.
- Torrents without videos offer a primary file or archive download and clear download-only labels. Small file sizes display bytes or KB instead of rounding down to 0 MB. The adult-content setting now explains that it applies to Explore and its title pages, not source search results.
- Settings adapts source guidance to its type, disables resolution while transcoding is off, adds section links, and makes diagnostics more compact and readable on phones.
- Converted playback keeps the picture, sound, clock and subtitles together after a resume or seek. Open-GOP video no longer drops a frame at each segment boundary.
- Refresh README screenshots and captions.
- Indexer sources no longer carry a configurable name; their display name is taken from the address's host, keeping the full hostname or IP instead of only its first label.
- Restore the `--accent` token for the torrent download-progress bar instead of a hardcoded colour.
- Remove horizontal separators between Settings sections; headings and spacing separate them.
- Previously opened torrents show their saved file lists without waiting for peers or checking cached video data again.
- Merging the release pull request tags that version and publishes its container image.
