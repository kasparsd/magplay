# VOD HLS playback: validation (2026-10-18 to 2026-10-23)

Evidence for [HLS streaming](../architecture.md#hls-streaming). Linux x86-64 cloud container, Node 22.22, ffmpeg 6.1.1 (Ubuntu).

## ffmpeg recipe

A 60 s H.264 MKV with B-frames, keyframes at irregular times (0, 2.5, 3, 7.75, 13, 14.25, 20, 21 …) and AC-3 audio, remuxed by one run from the start and by a restart at the 20 s keyframe, compared fragment by fragment (`tfdt` read directly, not through ffprobe, which applies edit lists):

| Variant | Result |
| --- | --- |
| HLS muxer, `-copyts` | Seek landed one keyframe early (14.25); audio `tfdt` restarted at 0 ("Track 1 starts with a nonzero dts … Set the delay_moov flag") |
| HLS muxer, `-ss` + `-output_ts_offset`, `delay_moov`/`frag_discont` via `-hls_segment_options` | Video aligned, but `tfdt` still run-relative: the HLS muxer keeps the run's start only in the edit list |
| `-ss` exactly on the boundary | Restarted segment's audio began 0.74 s after its keyframe (audio for that span is stored earlier in the file) |
| `-f mp4 -movflags +frag_keyframe+empty_moov+default_base_moof` | Fragment per keyframe, but `tfdt` run-relative |
| … `+frag_discont+negative_cts_offsets -use_editlist 0`, warm-up from the previous keyframe | Absolute `tfdt`; restarted video identical to the first run (30.000 s), audio within 11 ms; init segments byte-identical; the same through a pipe |
| Transcode with `-force_key_frames expr:gte(t,n_forced*6)` | Keyframes at the same times in both runs once run zero also seeks (`-ss 0.005` for a file starting at −0.005 s) |

`-ss` counts from the file's start time, and ffmpeg's CLI moves an input seek about 0.13 s earlier when the video has B-frames and the format doesn't seek by PTS; the 0.15 s seek margin covers both. `-progress` `out_time` is relative to the run's start.

## Keyframe indexes

`keyframeIndex()` against ffprobe's keyframe packet list: identical (maximum difference 0) for an MKV with irregular keyframes, the same video as MP4 with the moov first and last (keyframes at 0.005 s steps from its edit list), and a 29.97 fps MKV without B-frames. MPEG-TS and a PNG return no index.

## Server, with ffmpeg as the HLS client

The app on the e2e fixture media plus a 20-minute 160×90 MKV (B-frames, AC-3, 150 planned segments):

- The 90 s fixture's VOD playlist: 15 segments, `tfdt` exactly 6 s apart from 10 s.
- The 20-minute file: ffmpeg paused 244 s in; a request for the segment at 896 s restarted it there and was answered in 0.6 s, with the earlier 0–240 s still published.
- `ffmpeg -i …/index.m3u8 -f null -` decoded the whole stream across four ffmpeg runs with no warnings: 28,800 frames, 20:00.04.
- At a join between two runs (240 s): video `tfdt` continuous, audio overlap 10.7 ms.

## Tests

- Fast suite: 255 tests, including fragment splitting across arbitrary chunk boundaries, Matroska and MP4 indexes from synthetic files, segment plans, and sessions driven by a fake ffmpeg that streams real init and fragment boxes (restart and warm-up, waiting, published segments, coverage when the index is wrong, end of file, failures, pausing on player position and requested segments, eviction before stopping, growing playlists, merged subtitles).
- Chromium suite: the container's Chromium (141, `/opt/pw-browsers`) has no H.264 or AAC decoder (`MediaSource.isTypeSupported` false), so on unmodified `main` 37 of 54 tests fail there, all those that decode video. Browser playback was verified by the CI playback job, which installs Playwright's own Chromium: [run 39970101719](https://github.com/kasparsd/magplay/actions/runs/39970101719) on 2026-10-23 passed all 55 tests, including a seek 8 minutes into a 10-minute MKV after conversion had paused (no new play request, ffmpeg restarted, earlier converted range kept), the seek tooltip's "Converts from here", an MPEG-TS from a growing playlist, audio switching, subtitles on the file timeline and resume. Its first run failed two tests: a test that read the position before the new source loaded, and seeks in a growing playlist being clamped by `video.seekable`, which the player now combines with the server's converted ranges.

## Not verified

- Safari's native HLS with these segments (negative composition offsets, timestamps from 10 s); real devices are roadmap item 1.
- A seek into a part of a torrent that isn't downloaded, and the keyframe index read on such a torrent, on the real server; roadmap item 2.
