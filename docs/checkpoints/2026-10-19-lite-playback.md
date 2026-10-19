# Lite playback (no ffmpeg) — 2026-10-19

Validation of the server running without ffmpeg: the Node probe, the `browser-remux` mode and the two image targets. The design is in [Probe and playback modes](../architecture.md#probe-and-playback-modes); the image variants are in the README's Quick start.

## Probe without ffprobe

`packages/playback/src/probe.test.ts` reads six committed fixtures (`packages/playback/test-fixtures/`, 4–13 KB each, 64×64 at 0.5 s) over a file path and over an HTTP Range server: H.264/AAC MP4 (Baseline, default audio), MKV with AC3 "Surround" (eng, default) + AAC (lav) + SubRip "English", VP9/Opus WebM, HEVC `hvc1` Main 10 and `hev1` 8-bit without audio, and Hi10P H.264 in MKV ("High 10", 10-bit). Containers come back as `mp4`, `matroska`, `webm`; bit depth and profile come from the codec parameter strings; the Matroska subtitle track comes from the EBML `Tracks` scan with language and title. `keyframeBefore` returns 0 for the first second of these files and the requested time for a missing URL, never throwing. Unreadable inputs raise `MediaToolError`.

## Server without ffmpeg

`apps/server/src/services/play.test.ts` checks that with `serverConversion: false` an MKV with AC3 gets `{ mode: 'browser-remux', offset: 0, url: '/raw/ih/0', audio: 1 }` and starts no session, and that nothing is transcoded even with `allowTranscode`. `subtitles.test.ts` converts a SubRip file in Node (`WEBVTT`, `00:00:01.000 --> 00:00:02.500`) without calling ffmpeg, and rejects `.ass` files and embedded tracks with "no ffmpeg". `media.test.ts` runs `ffmpegVersion('/nonexistent/ffmpeg')` and gets `{ version: null, encoders: [] }`.

## Browser remux in Chromium

`tests/e2e/lite-playback.test.js` starts the real server with `FFMPEG_PATH=/nonexistent/ffmpeg` (a `serverEnv` worker option in the e2e fixtures). Results on 2026-10-19, headless Chromium 156, macOS arm64:

- `/api/status`: the `ffmpeg` check is `warn` with value "Not installed"; no `error` checks; `/api/debug` reports `ffmpeg: null, serverConversion: false`; the log has `ffmpeg.checked`.
- The faststart MP4 still plays `direct`.
- The MKV/AC3 fixture plays with real decoded frames (320 px wide, `totalVideoFrames` increasing, no media error) in `browser-remux`: `duration` is the whole file (90 s), a seek to 35 s lands at ≥ 35 s and keeps playing, switching to the second audio track answers `browser-remux` again and resumes above 34 s, and the external `.srt` converted in Node shows "Middle subtitle" with its cue at exactly 30 s media time.
- The full suite (78 tests, including the ffmpeg-backed HLS tests) passes alongside it in 3.8 min.

One bug was found and fixed by this test: `Output.getMimeType()` only resolves once the first packets have been muxed (the AAC encoder's codec string is not known before), so awaiting it before `Conversion.execute()` deadlocked silently. Conversion now starts first and the `SourceBuffer` is created when the MIME type arrives; output waits in a queue until then.

## Images

`docker build --target lite` and `--target full` on arm64: 339 MB and 495 MB. `tools/scripts/check-docker.mjs` passed against both: the full image's AC3 remux produced its first HLS segment in 222 ms (232 ms after a restart at 30 s); the lite image answered `browser-remux` for the same file, warned about ffmpeg, served `/raw` byte ranges, and idled at 107 MiB RSS inside the container with the fixture torrent loaded. Both run as `node` and contain no test files.
