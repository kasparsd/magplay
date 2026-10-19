# HLS segment timing — 2026-10-19

Follow-up to [the audio/video sync fix](2026-10-19-hls-av-sync.md). Two further fMP4 problems that Jellyfin had already hit, checked against this server's ffmpeg arguments. The rules are in [HLS session timing](../architecture.md#hls-session-timing).

## Open GOP, segment boundaries

An H.264 source with B-frames and an open GOP (`-x264-params open-gop=1`, keyframes every 2 s) was remuxed to fMP4 HLS. The first video sample's presentation time, read from `tfdt` + the first composition offset:

| Segment boundary | With the DASH index | With `skip_sidx` |
| --- | --- | --- |
| 0 s | 0.083 s | 0.083 s |
| 6 s | 6.082 s | 6.082 s |
| 12 s | 11.957 s | 12.082 s |
| 18 s | 17.999 s | 18.083 s |

From the second segment on, building the `sidx` index pulls the opening sample back to just before the boundary, onto a time the previous segment already ends at. Chrome drops one of the two frames. `skip_sidx` leaves the sample at the same composition offset as the first segment. HLS playlists do not read `sidx`. The flag has been in ffmpeg since 4.1.

## The clock after a seek

`ffprobe -skip_frame nokey -read_intervals <time>%+#1` returns the keyframe a copy will land on: 11.4 s → 10 s, 12 s → 12 s, 19.9 s → 18 s, on that 2 s GOP. The play response now uses that time as `offset` and ffmpeg seeks there. The player starts `request − offset` into the session, so a resume at 11.4 s shows 11.4 s, with the picture and the subtitle cue for that instant together.

`-copyts` would put the same origin into the timestamps themselves. It also disables the repair ffmpeg applies to a backwards audio timestamp (`Non-monotonic DTS … changing to …`). A constructed AAC glitch muxed without `-copyts` still produced segments; the same flags plus `-copyts` are what stall Jellyfin's copied-AAC sessions. The session stays zero-based for that reason, and the origin is reported beside it.

## Validation

- `packages/playback/src/media.test.ts`: segment options include `skip_sidx`; a remux seeks with `-noaccurate_seek`, a transcode does not.
- `apps/server/src/services/play.test.ts`: a remux at 35.2 s reports offset 34 and starts ffmpeg there; a transcode keeps 35.2 s and does not look up a keyframe.
- `tests/e2e/hls-sync.test.ts`: the keyframe lookup, and every open-GOP segment opening at or after its playlist boundary.
- The browser suite's subtitle cue at 1:10 stays within 0.2 s of `70 − offset` after a mid-file audio switch.
