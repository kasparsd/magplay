# Node memory in a container — 2026-10-19

Local measurement of how much RAM the Node process uses, and which Docker flags change it. The operating guidance is in [Container memory](../resources.md#container-memory). This did not run on the MikroTik host, did not open a swarm, and did not remux a full movie.

## Heap ceiling

`node:24-alpine` (Node v24.22.0), `docker run --memory=<limit> --memory-swap=<limit>`, printing `process.constrainedMemory()` and `v8.getHeapStatistics().heap_size_limit` from an empty process:

| Container limit | Heap ceiling |
| --- | --- |
| none (Docker Desktop VM) | 2240 MiB; constrained memory read as "no limit" |
| 96, 128, 192, 256, 384 and 512 MiB | 259 MiB, while constrained memory matched the limit |
| 768 MiB | 432 MiB |
| 1024 MiB | 560 MiB |
| 512 MiB with `--max-old-space-size=160 --max-semi-space-size=2` | 166 MiB |
| 512 MiB with only `--max-semi-space-size=1` | 259 MiB |

At every limit through 512 MiB the ceiling stayed above the container. `--max-semi-space-size` did not lower it.

## Idle core image

`magplay-eval:core`, built 2026-10-19T19:32:55Z, linux/arm64, 362 MB uncompressed, started with `--memory=512m`, `TORRENT_PORT=0`, DHT and local discovery off, and no peers. `docker stats` reported 50.54 MiB. `/proc/1/status` reported resident 112 MiB, of which 47 MiB was anonymous and 65 MiB was file-backed (the Node binary), 11 threads, and a virtual size of about 9 GB. That image predates the uncommitted Node remux path; idle still loads Mediabunny through the probe.

## One Node remux

The working tree's `runNodeRemux`, mounted into `node:24-alpine` at `--memory=512m`. The input was a generated 20-second 1280×720 H.264 plus AC-3 file, 11,099,844 bytes, not a torrent. `position()` stayed at 0, so the whole file converted in one go (the session's one-minute-ahead window is longer than the file). Anonymous pages are the ones the kernel cannot drop.

| | Resident | Anonymous | JS heap | Byte buffers |
| --- | --- | --- | --- | --- |
| File input, peak | 189 MiB | 130 MiB | 14 MiB | 63 MiB |
| File input, after collection | 126 MiB | 67 MiB | 10 MiB | — |
| HTTP input, peak | 215 MiB | (not split) | 18 MiB | 74 MiB |
| HTTP input, after collection | 140 MiB | (not split) | 14 MiB | 11 MiB, the file the test server held |

A second pass of the file input peaked at 168 MiB resident and returned to 119 MiB. It did not climb. The same file inside a 192 MiB limit with `--max-old-space-size=96` finished (peak resident 171 MiB, heap ceiling 99 MiB). A 160 MiB limit with the default 259 MiB ceiling also finished (peak resident 194 MiB). That survival is the reclaimable file pages, not spare anonymous memory: the anonymous peak on the unconstrained run was already 130 MiB, before WebTorrent and before the 48 MiB `/raw` cache could fill.

The macOS host (Node v26.12.0) idled the server at 98 MiB resident with no peers, and did not return memory to the OS after a remux. Those figures are not the container numbers above.
