# Memory caps — 2026-10-24

Option A of [the runtime performance research](../research/runtime-performance.md): bound the buffers the server holds, and cap the heap in the images. The operating guidance is in [Container memory](../resources.md#container-memory).

## Changes

- `packages/torrent-engine`: every torrent is added with `storeCacheSlots: 2` (WebTorrent's default is 20 whole pieces in memory).
- `packages/playback` Node remux: the `/raw` read cache is 16 MiB (was 48 MiB, the probe already used 16). Each emitted box copies the unsent tail into a new buffer, instead of keeping a subarray that held the whole grown buffer alive; growing the buffer keeps bytes written past a gap.
- `Dockerfile` core stage (and so `full`): `ENV NODE_OPTIONS=--max-old-space-size=128`.
- `tools/scripts/measure-memory.mjs`: the measurement below, against any image.

## Method

`node tools/scripts/measure-memory.mjs --image=<image>` on the macOS development machine, Docker 29.9.1, linux/arm64. The server runs in a container with `--memory=384m --memory-swap=384m`, DHT and local discovery off. The host seeds a generated 120 s 1080p H.264 file with stereo AC-3 (89 MiB, 23 pieces of 4 MiB) and the container reaches it through the magnet's `x.pe` peer hint at `host.docker.internal`. Phases: 5 s idle; one full `/raw` read while the pieces arrive from the peer; a second full read from the finished cache; 30 s settled; a Node remux HLS session (the core image has no ffmpeg) fetching the init segment and 60 s of segments; 30 s after the session is deleted. Every 200 ms the script reads `/proc/1/status` and the server's `process.memoryUsage()`, which a preload mounted into the container writes to a file.

Baseline: the core image built from `main` at 2caa562 (no heap cap). Changed: the same with this branch's changes.

## Results

Each image ran twice; the ranges cover both runs. MiB, peak during the phase unless noted.

| Phase | Anonymous, baseline | Anonymous, changed | Array buffers at the end, baseline → changed |
| --- | --- | --- | --- |
| Idle | 46 | 46 | 1 → 1 |
| Stream from the peer | 142–148 | 141–147 | 78 → 92 |
| Stream from the cache | 168–198 | 140–160 | 125 → 28 |
| Settled (value at the end) | 143–144 | 134–140 | 89 → 89 |
| Node remux, 60 s | 271–299 | 175–186 | 157 → 70 |
| After the session (value at the end) | 255–265 | 145–153 | 157 → 52 |

- Resident memory is anonymous plus about 60 MiB of mapped files (mostly the Node binary): idle 105 MiB in both.
- The V8 heap stayed at 21–29 MiB used, 25–36 MiB total, in every phase of both images. The growth is byte buffers outside the heap, and freed pages the allocator keeps (anonymous memory stays near its peak when array buffers fall).
- Heap ceiling in a 384 MiB container: 259 MiB before, 131 MiB after; `-e NODE_OPTIONS=--max-old-space-size=256` gives 259 MiB again.

## Findings

- The remux changes take about 100 MiB off a Node remux's peak and about 110 MiB off what stays afterwards. Before, one 60 s remux brought the server within 85 MiB of a 384 MiB limit.
- `storeCacheSlots: 2` has no measurable effect in this test. After streaming settles, both images hold about 89 MiB of array buffers, roughly the whole 92 MiB file, so something other than WebTorrent's piece cache retains it. What it is was not investigated. The research's estimate of up to 150 MiB per torrent from the piece cache is not supported by these numbers.
- A Node remux of 5.1 AC-3 audio never writes its `moov` and spins at full CPU, on `main` as well; stereo AC-3 converts 30 s in under a second. The measurement uses stereo for that reason. The fix is separate work.

## Not covered

One torrent, one sequential reader, a fast loopback peer and a short file. No real swarm, slow peers, seeking, several torrents or seeding uploads, which is where a piece cache would matter most. Not run on the MikroTik host or amd64, and ffmpeg sessions (the `full` image) were not measured.
