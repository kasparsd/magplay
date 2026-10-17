# Performance graphs and player view

Show how playback and downloads perform over time, so a stall can be traced to its cause (swarm, NAS CPU or browser) and a download's progress and ETA are visible without reading the peer table.

Design options are mocked in the [magplay performance graphs artifact](https://claude.ai/artifact/8p2zDto3EHRTj8ja7kheTm): A sparklines in ⓘ Details, B a three-lane playback pipeline chart, C a stats overlay on the video, D a throughput chart on the Torrent page, E a "Now" panel on the home page. The same artifact covers the player view: F one overlay chrome for every mode, G theater (edge to edge), H immersive, I a side rail with episodes and performance.

## What the API has today

`GET /api/torrents/:ih/status` (`statusRoute` in `apps/server/src/server.js`, `status()` in `apps/server/src/torrents.js`) returns instantaneous values only:

- Torrent: `downloadSpeed`, `uploadSpeed`, `downloaded`, `progress`, `files[]`, `peers[]` (per-peer speeds, `choking`, `share`), `activeStreams`, and `file.ranges` when `idx` is given.
- Session, with `?session=&pos=`: `speed` (× realtime), `produced`, `paused` (ffmpeg is SIGSTOPped 240 s ahead), `running`, `failed`.
- Client only: `video.buffered`, `waiting` events, `getVideoPlaybackQuality()`.

Missing: any history, ffmpeg CPU, ffmpeg `fps`/`bitrate` (in the `-progress` stream but dropped in `apps/server/src/sessions.js`), NAS load and cache usage, and a list of loaded torrents (`/api/recent` lists the disk cache).

## Decision and status

On 2026-10-17 the chosen direction was F (one overlay chrome) with G (theater layout) as the default, followed by B (playback performance graph). The specification and implementation checklists now live in the [Player roadmap](../user-interface.md#player-roadmap); track progress there. Options C, D, E, H and I are listed there under "Later, if use calls for it".

## Open questions

- Should the Performance lanes eventually replace the snapshot rows in ⓘ Details? For now they sit beside them.
- On macOS dev hosts there is no `/proc`; use `ps -o %cpu` there or leave CPU empty.
