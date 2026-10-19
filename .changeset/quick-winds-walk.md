---
"@magplay/api-contract": minor
"@magplay/client": minor
"@magplay/playback": minor
---

magplay runs without ffmpeg. A new `-lite` image (`edge-lite`, `<version>-lite`) has no ffmpeg: MP4/WebM play directly, MKV and AC3/E-AC3/DTS audio are repackaged in the browser (new `browser-remux` mode, whole-file timeline, seeking and audio switching without the server), `.srt`/`.vtt` files in the torrent still work, and anything that needs converting opens in an external player. Files are probed in Node instead of ffprobe, so `FFPROBE_PATH` is gone and ffprobe is no longer needed anywhere. On the full image a missing or broken ffmpeg is now a status warning instead of a failed start, and the transcode settings are disabled while it is missing. Container names in Details and the probe API are now short ids (`mp4`, `matroska`, `webm`).
