---
"@magplay/server": patch
---

Defer hls.js playback until the manifest is parsed, so HLS streams (especially on slower or incomplete torrents) actually start instead of stalling after the playlist becomes ready. Also make Space/Spacebar reliably toggle play/pause across browsers.
