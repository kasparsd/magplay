# Image size with a custom ffmpeg and no source maps — 2026-11-04

linux/arm64 unless noted, Docker, Alpine 3.24. Both columns were built on one machine and cache: `main` at `c7c0ead` and the branch that builds ffmpeg from source and stops shipping the client's source maps ([ffmpeg build](../architecture.md#ffmpeg-build)). Unpacked is the sum of layer sizes (`docker history`). Pull is the gzip size of `docker save`, an approximation of the registry's compressed size.

| Image | | Unpacked | Pull (approx.) |
| --- | --- | --- | --- |
| `magplay-core` | before | 120.0 MB | 39.0 MB |
| `magplay-core` | after | 106.8 MB | 36.5 MB |
| `magplay` | before | 227.7 MB | 86.2 MB |
| `magplay` | after | 125.0 MB | 43.0 MB |

The amd64 `magplay` image (built under emulation, so no `main` comparison) is 130.7 MB unpacked and 44.3 MB to pull: its ffmpeg is 7.9 MB and also links libvpl for Quick Sync, whose `h264_qsv` encoder and `vpp_qsv` filter are present.

Where it came from:

- **Source maps:** `dist/client` went from 17.4 MB to 4.9 MB (12.9 MB of maps), which is all of `magplay-core`'s saving.
- **ffmpeg:** Alpine's package, with its 100-odd libraries, is replaced by a 6.3 MB binary and Alpine's x264, dav1d and libva (the rest of `magplay`'s 102.7 MB saving). `magplay` is now 18 MB larger than `magplay-core`, down from 108 MB.

## Does the custom ffmpeg do the same work

`tools/scripts/check-ffmpeg.mjs` runs the app's own arguments (`ffmpegArgs`, `subtitleToVtt`, `encoderProbeArgs`) in the image over 15 generated files: H.264, HEVC, VP9, AV1, MPEG-2, MPEG-4 and WMV2 video; AC-3, E-AC-3, DTS, TrueHD, FLAC, Opus, MP3, AAC (copied) and WMA audio; in MKV, MP4, WebM, AVI, MPEG-TS, ASF and FLV; with SRT, ASS and `mov_text` subtitles; a 5.1 track; and an HTTP source with range requests. Each file is remuxed from the start and from 1 s, transcoded to 120p with libx264, and its subtitles converted.

| Image | Checks passed |
| --- | --- |
| Alpine's ffmpeg 8.1.3 (the previous image) | 47 / 47 |
| Custom ffmpeg 8.1.3, arm64 | 47 / 47 |
| Custom ffmpeg 8.1.3, amd64 (under emulation) | 47 / 47 |

With `REFERENCE=<alpine image>` every run also executes on Alpine's ffmpeg and the output files (fragmented MP4 and WebVTT) had to be byte-identical; they were, including the libx264 transcodes and the AAC encodes. The hardware probe fails the same way on both when there is no device (`No VA display found`), and `scale_vaapi` and `hwupload` are present. On amd64 the same comparison against Alpine's amd64 ffmpeg also matched. A real VAAPI or Quick Sync encode was not run: neither image contains a GPU driver and this host has no GPU.

`tools/scripts/check-docker.mjs magplay:slim` also passed: health, probe, raw ranges, an AC-3 remux served as HLS from 0 and from 30 s (first segment in 214 ms and 238 ms), metrics, logging and shutdown.

Found along the way, and unchanged: MPEG-TS files with ADTS AAC audio cannot be copied into MP4 (`Malformed AAC bitstream detected: use the audio bitstream filter 'aac_adtstoasc'`) on Alpine's ffmpeg either, because `ffmpegArgs` never passes `-bsf:a aac_adtstoasc`. The check asserts the failure so that fixing the arguments shows up.
