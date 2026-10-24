# @magplay/playback

## 0.2.1

### Patch

- Videos with 5.1 or other multichannel audio play on iPhones and other browsers without Media Source Extensions when the server has no ffmpeg, instead of never starting. If that conversion ever stops producing video, playback now fails with an error instead of waiting forever.
- A server without ffmpeg uses about 100 MiB less memory while it converts a video for playback.

## 0.2.0

### Minor

- Seeking in a remuxed or converted video is now an ordinary seek. The player gets one playlist for the whole file, the server converts whatever part you jump to, and parts already converted play straight away when you seek back. Subtitles and the seek bar stay in step after seeks and audio switches. Files without a keyframe index (MPEG-TS, AVI) play from the start and can be seeked as far as conversion has reached.

## 0.1.0

### Minor

- magplay runs without ffmpeg. Next to `ghcr.io/kasparsd/magplay` (unchanged: with ffmpeg) there is now `ghcr.io/kasparsd/magplay-core`, which has no ffmpeg: MP4/WebM play directly, MKV and AC3/E-AC3/DTS audio are repackaged in the browser (new `browser-remux` mode, whole-file timeline, seeking and audio switching without the server), `.srt`/`.vtt` files in the torrent still work, and anything that needs converting opens in an external player. A browser that cannot repackage a file itself (no Media Source Extensions) gets that repackaging done in Node and plays the result as HLS. Files are probed in Node instead of ffprobe, so `FFPROBE_PATH` is gone and ffprobe is no longer needed anywhere. On the full image a missing or broken ffmpeg is now a status warning instead of a failed start, and the transcode settings are disabled while it is missing. Container names in Details and the probe API are now short ids (`mp4`, `matroska`, `webm`).
