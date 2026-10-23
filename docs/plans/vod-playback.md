# VOD playback: full-length HLS playlists with segments made on demand

Started 2026-10-18. Replaces the live-growing HLS session that restarted from an offset on every seek or audio change.

## Goal

The browser gets one full-length video-on-demand playlist per file and plays it on the file's own timeline. Seeking is a normal seek in hls.js or Safari. When the browser asks for a segment ffmpeg hasn't made, the server restarts ffmpeg at that segment without the browser knowing. This removes the session offset, the restart-on-seek decision, the seek prediction against `video.seekable`, and waiting for a growing playlist from the client. The seek bar, duration and subtitles use one timeline.

Out of scope: server-side watch state (resume stays in the browser), and sharing a converted stream between tabs.

## Before

Each play request started one ffmpeg writing an EVENT playlist from `start`. The client kept `offset` and converted between session and file time. A seek outside what hls.js had loaded made a new `/api/play` request and a new session; switching audio did the same. Subtitles from the session were timed from the session start.

## Design

### Segment plan

A segment must start on a keyframe when the video is copied (remux), and the same segment must come out identically whichever ffmpeg run produces it.

- **Remux:** keyframe times come from the file's own index, read with a few range requests on `/raw`: Matroska `Cues` (through the `SeekHead`) or the MP4 video track's sample tables (`stss`, `stts`, `ctts`, `elst`). Boundaries are keyframes grouped into segments of at least 6 s. A cue list that misses some keyframes only makes segments longer.
- **Transcode:** fixed 6 s segments; ffmpeg forces a keyframe at each boundary.
- **No index** (MPEG-TS, AVI, an MKV without cues, fragmented MP4) or unknown duration: a growing EVENT playlist from one ffmpeg run that starts at 0 and never restarts. Seeking is limited to what has been converted; the client clamps to it.

### One ffmpeg run at a time per session

ffmpeg writes fragmented MP4 to a pipe (`-f mp4 -movflags +frag_keyframe+empty_moov+default_base_moof+frag_discont+negative_cts_offsets -use_editlist 0`), which cuts a fragment at every keyframe. The server splits the stream into the init segment and fragments, reads each fragment's start from its `tfdt`, and groups fragments into the planned segments. A segment is published once the run has covered it from its start to the next boundary. Requests are answered from published segments: by waiting when the running ffmpeg will reach the segment soon, otherwise by restarting ffmpeg there. Published segments from earlier runs stay until the HLS disk budget needs the space, so seeking back to something already converted does not convert it again.

### Timestamps (verified 2026-10-18 with ffmpeg 6.1)

- `-ss` adds the file's `start_time`, and ffmpeg's CLI subtracts about 0.13 s when the video has B-frames and the format doesn't seek by PTS. Every run therefore seeks to a target `T` with `-ss (T − start_time)` (left out when not positive) and `-output_ts_offset (T + 10)`. The output timeline is the file's own timestamps plus 10 s in every run. The offset keeps early audio packets and B-frame reordering above zero, so the muxer never shifts one run differently from another.
- Without `frag_discont` and `negative_cts_offsets`, `tfdt` starts at 0 in every run (the run's start is only in an edit list, which hls.js ignores). With them, `tfdt` is absolute, video fragments start exactly at the keyframe's PTS, and the init segment is byte-identical across runs.
- **Remux restarts** seek one indexed keyframe before the requested boundary and discard that warm-up output. Starting exactly on the boundary left a 0.7 s audio hole at the start of the segment, because the audio for that span is stored earlier in the file. With the warm-up, video in the restarted segment matches the first run to the millisecond and audio within one AAC frame. Audio uses `-noaccurate_seek` so ffmpeg doesn't trim it to the target.
- **Transcode restarts** seek exactly to the boundary with accurate seeking, and keyframes are forced at `T + 6n`, which matches the plan.
- Subtitles from the same ffmpeg get `-output_ts_offset T`, so cues are on the file's timeline. The session's `sub_N.vtt` merges all runs' cues.

### Wire changes

- `PlaybackDecision` loses `offset`. HLS URLs point at the session's VOD playlist; `start` in the play request only chooses where the first ffmpeg run begins.
- `SessionStats.produced` and `readyUntil` become absolute file times, and `ready` lists the converted ranges for the seek bar.
- `ProbeResult` gains `startTime`.

## Progress

- [x] Verify the ffmpeg recipe (timestamps, warm-up, init identity, pipe output, transcode alignment).
- [ ] Keyframe index: Matroska cues and MP4 sample tables, with tests.
- [ ] Segment plan, fragment splitter and playlist, with tests.
- [ ] HLS sessions: runs, restarts, waiting, published segments, merged subtitles, disk budget, readiness, stats.
- [ ] Server: play service reads the index, `/hls` serves playlist, init, segments and subtitles; contract changes.
- [ ] Client: no offset, native seeks, seek hints for unconverted ranges, merged subtitles, growing-mode clamp.
- [ ] Browser tests for seeking into unconverted ranges, audio switching, subtitles, resume and the no-index fallback.
- [ ] Update README, architecture, lifecycle and user-interface docs; release note.

## Risks and checks still owed

- Safari's native HLS with these fMP4 segments (negative composition offsets, `tfdt` starting at 10 s) is not covered by the Chromium suite. Check on a real device (roadmap item 1).
- Keyframe indexes that disagree with the actual keyframes would make planned segments start mid-GOP. The session serves the fragment that covers the boundary instead, so playback continues with a small overlap, and logs `hls.plan.mismatch`.
- A segment boundary from one run next to a segment from another run can overlap or leave a gap of under one AAC frame (about 21 ms) of audio.
