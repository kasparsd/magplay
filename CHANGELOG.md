# magplay

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
