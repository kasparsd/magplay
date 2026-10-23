# Server resource safeguards

These limits protect a single-user deployment from accidental overload through tabs, rapid retries and abandoned work. They are admission controls, not multi-user scheduling.

| Setting | Default | Meaning |
| --- | --- | --- |
| `MAX_HLS_SESSIONS` | `2` | Retained HLS sessions, including completed output until cleanup. Replacing the same tab's session does not require another slot. |
| `MAX_TORRENT_LOADS` | `4` | Concurrent distinct torrent initialization jobs. Requests for one hash still share one job. |
| `MAX_PROBES` | `2` | Concurrent probes (header reads in Node); requests for the same cached/pending probe share its result. |
| `MAX_SUBTITLE_JOBS` | `1` | Concurrent standalone subtitle conversions. HLS subtitles belong to their existing HLS process. |
| `HLS_MAX_GB` | `8` | Total soft budget for retained HLS output, separate from the torrent cache budget. |
| `MIN_FREE_GB` | `0.25` | Filesystem free-space reserve required to start/continue HLS work. |

Job/session limits must be positive integers; storage values must be positive finite numbers. Invalid values fail at startup. The GB values use 1024³ bytes, consistent with `CACHE_MAX_GB`.

Overload returns HTTP **503**, JSON with a useful message, `Retry-After: 5` and `Cache-Control: no-store`. Work is rejected rather than queued indefinitely. Clients must not automatically retry playback POSTs. Close another player, wait for its cleanup, retry explicitly, or use an external player/direct stream.

Before admitting HLS, the server checks session capacity and filesystem free space without terminating an existing session on rejection. Every two seconds it checks total output and free space. If a disk limit is crossed, it stops the largest-output session(s), removes their generated HLS files, and retains a failed status with the disk-limit explanation. Torrent data is **never** deleted by this monitor. Published segment sizes are cached to avoid repeatedly statting every immutable segment.

This is a **soft budget**, not an operating-system disk quota: output and other processes can consume space between checks. Use a dedicated filesystem/container storage quota if a hard bound is required. Startup probing/subtitle work and raw downloads can still grow the torrent cache; active torrents remain protected from its LRU eviction. Data kept for seeding is evicted only after all other cache data, oldest first, and never while a stream of it is open or it is loading; seeding never lets the cache exceed `CACHE_MAX_GB`. The reserve does not promise a whole-machine free-space guarantee.

## In-memory caches

Long-running servers keep a few answers in memory. Each one is bounded, and Settings → Debug lists their current sizes next to the busy slots.

| Cache | Bound | Notes |
| --- | --- | --- |
| Probe results | 256 inputs, least recently used out | A file's streams don't change, so only the count is bounded. A failed probe is forgotten so the next request retries. |
| Converted subtitle tracks | 64 tracks and 64 MiB of WebVTT, least recently used out | The newest track is always kept, however big. |
| Search download links | 5,000 opaque link IDs | The links can carry indexer API keys, so they never reach the browser. An evicted ID answers 410 "search again". |
| Explore answers | 200 entries, 60 s (counts 15 min) | Cleared when BitMagnet's address changes. |
| Debug log tail | 200 records and 512 KiB | Sanitized records, each at most 8 KiB; stdout buffering is bounded separately. See [logging](logging.md). |
| Closed player tabs | 1,000 fences of three minutes | See [lifetimes](lifecycle.md). |

These are fixed constants rather than settings: none has needed tuning, and the Debug numbers show whether one ever does.

Keep `HLS_MAX_GB` large enough for expected remux output: HLS retains past segments to support seeking, so pause-ahead throttling alone does not bound a long film's total output. Raising the budget may be preferable to server transcoding; external players use no HLS storage. Observe representative files on the actual server before tuning the defaults.

## Container memory

A memory limit on the container does not make Node stay inside it. On Node 24 (`node:24-alpine`), every limit from 96 MiB through 512 MiB left the V8 heap ceiling at 259 MiB. The ceiling starts to follow the limit only above that (768 MiB → 432 MiB, 1 GiB → 560 MiB). Below the ceiling V8 keeps allocating, and the kernel kills the process before a collection. The images therefore set the heap explicitly:

```sh
NODE_OPTIONS=--max-old-space-size=128
```

In a 384 MiB container that gives a 131 MiB heap ceiling instead of 259 MiB. Setting `NODE_OPTIONS` replaces it, for example on a large host that keeps more in memory. Run outside the images, Node needs the same option in any container of 512 MiB or less. 128 MiB of heap is enough for this server. `--max-semi-space-size` only shrinks the young generation, which is already small here, and does not move the spike below.

The rest is memory Node does not count as heap: byte buffers, the codec workers, and freed pages the allocator keeps instead of returning. Measured in the core image in a 384 MiB container on linux/arm64, with one torrent of a 120 s 1080p H.264/AC-3 file (89 MiB) streamed from a local peer ([checkpoint](checkpoints/2026-10-24-memory-caps.md)):

| | Anonymous | Of which array buffers |
| --- | --- | --- |
| Idle, no peers | 46 MiB | 1 MiB |
| Streaming the file over `/raw`, peak | 141–160 MiB | up to 92 MiB |
| Settled after streaming | 134–140 MiB | 89 MiB |
| A Node remux of 60 s, peak | 175–186 MiB | 70 MiB at the end |

The V8 heap stayed below 30 MiB used throughout. Resident adds about 60 MiB of mapped files, mostly the Node binary, which the kernel can drop. Virtual size is about 9 GB and is not RAM.

What holds the bytes:

- **Node remux:** its `/raw` read cache is 16 MiB, and the output keeps only the unsent part of the box being written. Before those limits (48 MiB, and a buffer that kept every size it had grown to) the same remux peaked at 271–299 MiB.
- **Torrent pieces:** each torrent keeps 2 whole pieces in memory after a read (WebTorrent's default is 20). In the measurement this made no measurable difference. About 89 MiB of buffers, roughly the whole file, stays held after streaming either way, for a reason not yet found.

For one Node remux, give the container 384 MiB and no extra swap (`mem_limit` and `memswap_limit`, or `docker run --memory=384m --memory-swap=384m`). That leaves about 200 MiB above the remux peak for real swarms, seeking and several torrents, none of which were measured. It is not a budget for an ffmpeg transcode, which runs in another process. `tools/scripts/measure-memory.mjs --image=<image>` repeats the measurement.

Deleting unused files from `node_modules`, which the image build does, changes the image size and not this resident set. Node does not map a file until it imports it. The heap-ceiling measurements are in [the 2026-10-19 checkpoint](checkpoints/2026-10-19-node-container-memory.md), taken on `node:24-alpine`. The image has since switched to Alpine's `nodejs` package ([image size](checkpoints/2026-10-19-docker-image-size.md)). A host with real peer counts, including MikroTik, is still an open check ([roadmap](roadmap.md)). A host with real peer counts, including MikroTik, is still an open check ([roadmap](roadmap.md)).
