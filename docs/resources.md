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

A memory limit on the container does not make Node stay inside it. On Node 24 (`node:24-alpine`), every limit from 96 MiB through 512 MiB left the V8 heap ceiling at 259 MiB. The ceiling starts to follow the limit only above that (768 MiB → 432 MiB, 1 GiB → 560 MiB). Below the ceiling V8 keeps allocating, and the kernel kills the process before a collection. In any container of 512 MiB or less, set the heap explicitly, under the limit:

```sh
NODE_OPTIONS=--max-old-space-size=128
```

128 MiB of heap is enough for this server. A Node remux used about 14–20 MiB of it. `--max-semi-space-size` only shrinks the young generation, which is already small here, and does not move the spike below.

The spike is memory Node does not count as heap. On linux/arm64, one Node remux of a 20-second 11 MB H.264/AC-3 file reached 130 MiB anonymous (189 MiB resident, the rest being the mapped Node binary). About 63 MiB of that peak was byte buffers: the remux's `/raw` read may hold 48 MiB, and the unpublished output buffer doubles as it grows. The AAC, AC-3 and DTS codec workers live in the same process. After the session and a collection, anonymous use fell to 67 MiB, and a second pass did not climb. The idle core image, with no peers, was 51 MiB in `docker stats` and 47 MiB anonymous. Resident was 112 MiB; most of the difference is the Node binary, which the kernel can drop. Virtual size is about 9 GB and is not RAM.

For one such remux, give the container 384 MiB and no extra swap (`mem_limit` and `memswap_limit`, or `docker run --memory=384m --memory-swap=384m`). The 384 MiB is headroom for that anonymous peak plus WebTorrent's own piece cache. It is not a budget for an ffmpeg transcode, which runs in another process and was not part of this measurement. 256 MiB is tight once the 48 MiB input cache fills. A 160 MiB limit survived the short file only because part of its resident set was reclaimable file pages.

Deleting source maps, type declarations and markdown from `node_modules`, which the image build already does, changes the image size and not this resident set. Node does not map a file until it imports it. The measurement, including what it does not cover, is in [the checkpoint](checkpoints/2026-10-19-node-container-memory.md). A host with real peer counts, including MikroTik, is still an open check ([roadmap](roadmap.md)).
