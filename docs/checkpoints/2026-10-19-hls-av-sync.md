# HLS audio ahead of video — 2026-10-19

Users reported audio running ahead of video in HLS sessions in current Chrome, sometimes Firefox, most visibly after resuming at a saved position. Safari was not affected. The cause was in the segments ffmpeg wrote, not in the player; the lasting rules are in [architecture](../architecture.md#hls-session-timing).

## Diagnosis

A 60 s H.264 (B-frames, 2 s GOP) + AC3 MKV was remuxed with the server's exact `ffmpegArgs` output and the boxes of `init.mp4` and `seg_00000.m4s` were read directly:

| Resume at 37 s (keyframe at 36 s) | video | audio |
| --- | --- | --- |
| `tfdt` (first fragment) | 0 | 0 |
| first presentation time in the fragment | 0.083 s | 0 |
| `elst` in `init.mp4` | empty edit 0.083 s | empty edit 1.062 s |

The 1 s between the keyframe and the trimmed audio, the 2-frame B-frame delay and the AAC priming existed only as edit lists. hls.js passes the init segment through without reading `elst`; Chromium's MP4 parser logs "Empty edit list entry ignored" and uses no offset. The browser therefore played audio from the keyframe together with video that was really about a second earlier.

## Measurement

A source with the picture turning white and a tone starting at the same instant was remuxed with the server arguments and decoded with `-ignore_editlist 1`, which is what MSE effectively does. Audio lead over video:

| | before | after |
| --- | --- | --- |
| fresh start (`start = 0`) | 0.048 s (B-frame delay minus priming) | −0.013 s |
| resume 0.5 s after a keyframe | 0.548 s | −0.013 s |
| the source itself | −0.013 s | |

−0.013 s is `silencedetect`'s onset latency, so "after" matches the source. The change was `-noaccurate_seek` with `-ss` and `-hls_segment_options use_editlist=0:movflags=+frag_discont:avoid_negative_ts=disabled`; `init.mp4` now has no `elst` and the audio fragment carries its real `tfdt`. Variants measured and rejected: `use_editlist=0` alone (movenc moves the first audio sample to 0 and stretches its duration over the gap), `negative_cts_offsets` (libavformat's own demuxer then reads the video late by the B-frame delay).

## Validation

- `packages/playback/src/media.test.ts`: the argument list carries `-noaccurate_seek` with `-ss` and the segment options in every HLS session.
- `tests/e2e/hls-sync.test.ts`: generates the marker source, runs the real arguments for a fresh start and a resume, and requires the flash and the tone within 50 ms and no edit list. With the fix stashed it fails with "audio leads video by 0.554 s".
- `npm test` (260), `npm run typecheck`, `npm run lint`, `npm run test:e2e` (74; one direct-playback resume test flaked under full-suite load and passed 3/3 alone — it uses no HLS).
- hls.js 1.7.3 in Chromium plays the new segments across the existing seek-restart, audio-switch and resume tests.

## Open

The session timeline now begins at the keyframe before `start` for both tracks, while `offset` reports `start`: the position readout and subtitles lead the picture by the keyframe distance after a resume, seek restart or audio switch (previously only the video did). Roadmap item 3 holds the follow-up.
