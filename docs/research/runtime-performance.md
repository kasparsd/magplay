# Runtime performance and memory: Node, Bun or Rust — 2026-10-23

A planning input, not a decision. It asks what it would take to make the server use less memory and CPU, and whether moving it to Bun or rewriting it in Rust is worth it. The browser client is out of scope: it stays React whatever the server runs on, and the server never executes it.

**Update 2026-10-24:** option A is done and measured ([checkpoint](../checkpoints/2026-10-24-memory-caps.md)). The remux limits took about 100 MiB off a Node remux's peak, and the images now cap the heap. The piece-cache prediction held once garbage is collected: `main` kept 77 MiB of pieces after one stream, `storeCacheSlots: 2` keeps 5 MiB of buffers and 56 MiB anonymous, 10 MiB above idle. Without a collection both read about 89 MiB, because an idle V8 leaves the dropped pieces allocated. Option A's lazy imports and `maxConns` knob were not done.

## Where memory goes today

Measured numbers come from [container memory](../resources.md#container-memory) and its [checkpoint](../checkpoints/2026-10-19-node-container-memory.md), plus the measurements below, taken on macOS with Node 26.12 on 2026-10-23.

| What | Memory | Source |
| --- | --- | --- |
| Idle server in the core container, no peers | 47 MiB anonymous, 112 MiB resident (65 MiB is the mapped Node binary, which the kernel can drop) | checkpoint, linux/arm64 |
| Idle server on macOS, no peers, DHT off | 131 MiB resident | measured |
| Empty Node process | 13 MiB resident | measured |
| Importing `webtorrent` | +28 MiB resident, +9 MiB heap, 250 ms | measured |
| Importing `mediabunny` | +13 MiB resident | measured |
| Importing `@prometheus-io/client` | +7 MiB resident | measured |
| Importing `fast-xml-parser` / `pino` | +5 / +3 MiB resident | measured |
| `node-datachannel` (WebRTC, unused) | +2 MiB resident | measured |
| One Node remux of a 20 s file, peak | 130 MiB anonymous, of which 63 MiB byte buffers (a 48 MiB `/raw` read cache, plus an output buffer that doubles as it grows) | checkpoint |
| WebTorrent's piece cache | up to 20 whole pieces per loaded torrent; **not measured** | code reading, below |
| ffmpeg remux/transcode | a separate process; not part of the Node numbers | — |

### Unmeasured and likely the largest: WebTorrent's piece cache (confirmed; see the update above)

`createTorrentEngine()` (`packages/torrent-engine/src/engine.ts`) passes no `storeCacheSlots` to `client.add()`, so every torrent gets WebTorrent's default: a `cache-chunk-store` LRU of **20 whole pieces** in memory, filled by reads (playback, the probe, ffmpeg, seeding uploads). Piece size grows with the torrent: 2–8 MiB for typical films, 16 MiB for large 4K releases. That is 40–160 MiB per loaded torrent, and up to 320 MiB for a large one, with up to four loading and three seeded torrents loaded at once. On a 384 MiB container this alone can exceed the limit, and none of it shows in the V8 heap, so `--max-old-space-size` does not bound it. The disk store already holds every piece, so the cache only saves re-reading from the page cache, which the kernel keeps anyway.

## What a runtime change can and cannot affect

- **Fixed per-process cost:** the runtime itself and the code it loads. Bun or Rust shrink this.
- **Byte buffers:** piece caches, read-ahead caches and output buffers. These are configuration and algorithm choices; they cost the same in every language until someone changes them. Today they are the peak.
- **ffmpeg:** remux and transcode CPU and memory are ffmpeg's in every option.
- **CPU per byte:** WebTorrent does wire parsing, piece bookkeeping and SHA-1 checks in JavaScript, with many small buffers. A native torrent engine is much cheaper per byte. This matters only where the CPU is the bottleneck, which is plausible on a MikroTik ARM host but has not been measured (roadmap item 4 records no throughput yet).

## Options

### A. Stay on Node and fix the buffers (days)

| Change | Expected effect | Effort |
| --- | --- | --- |
| Set `storeCacheSlots` to 2–4 (or 0) in `client.add()`; the disk store and the OS page cache already serve re-reads | Removes up to ~150 MiB per streaming torrent; bounds seeded torrents too | Hours, plus a peer-suite run and a throughput check |
| Lower Node remux's `UrlSource` `maxCacheSize` from 48 MiB to 8–16 MiB, and write output into a list of chunks instead of a doubling buffer | Peak anonymous −40 to −55 MiB per remux | A day; re-run the HLS sync test |
| Bake `--max-old-space-size=128` into the core image's `CMD` (or `ENV NODE_OPTIONS`) | Stops the 259 MiB heap ceiling from outgrowing small containers; no saving, but removes an OOM trap people must know about today | Minutes |
| Import Mediabunny, the codec workers, and the Prometheus client only on first use (metrics only when `/metrics` is scraped) | Idle −10 to −20 MiB | A day; keep "no work at import time" |
| Lower `maxConns` (WebTorrent defaults to 55 per client) on small hosts | Fewer sockets and wire buffers; less CPU | Hours; make it an env-only knob |

These address everything in the table above except the fixed Node runtime cost and the per-byte CPU of WebTorrent. Expected outcome on a small host: idle unchanged at ~45–50 MiB anonymous, playback peak bounded at roughly 100–150 MiB instead of the current unbounded piece cache.

### B. Run the same code on Bun (a spike, then days to weeks)

What it would give: JavaScriptCore usually starts with a smaller resident set than V8, Bun strips TypeScript natively as Node does now, and `bun --smol` trades speed for a smaller heap. A realistic gain is 10–30 MiB at idle. It does not shrink the piece cache, the remux buffers or ffmpeg, and WebTorrent stays the same JavaScript, so CPU per byte barely moves.

What would need checking, each of which this codebase depends on (none were tested; Bun is not installed here):

- **`.local` names.** `apps/server/src/mdns.ts` replaces `dns.lookup`, relying on Node's `fetch` reading it per connection. Bun's `fetch` uses its own resolver, so the avahi fallback would likely stop working.
- **Event loop metrics.** `packages/observability/src/runtime.ts` uses `perf_hooks.monitorEventLoopDelay`, which Bun has not implemented in the past.
- **The HLS producers.** ffmpeg writes fragmented MP4 to an extra pipe on fd 3 (`stdio: ['ignore', 'pipe', 'pipe', 'pipe']`), and both producers are paused with `SIGSTOP`/`SIGCONT`. Extra stdio pipes in `node:child_process` must behave the same.
- **Native modules.** `node-datachannel`, `bufferutil` and `utf-8-validate` through N-API, on musl.
- **Memory limits.** No `--max-old-space-size`; JSC's heap and its behaviour under a cgroup limit would need their own measurement.
- **Tests.** 39 files use `node:test`. They can keep running on Node, but then the tested runtime is not the shipped one.

Verdict: a one-day spike is cheap (run the server and `npm run test:peers` under Bun, compare idle and playback memory on arm64), but only worth doing after option A, because A's savings are larger and Bun's savings are small and uncertain.

### C. Replace only the torrent engine with Rust (1–3 weeks)

The `TorrentEngine` interface (`add`, `get`, `file().read(start, end, signal)`, `status`, `recent`, `openStream`, `housekeeping`, `close`) is already the boundary; nothing outside the package touches WebTorrent. [librqbit](https://github.com/ikatson/rqbit) is a Rust BitTorrent library with DHT, trackers, TCP, and seekable file streams that prioritise the pieces being read. It could be used either as:

- **a sidecar process** (rqbit's HTTP API, or a small Rust binary of our own): no native build in npm, but two processes to supervise, and status, seeding ratio, saved metadata and eviction mapped onto its API; or
- **an in-process N-API module** (napi-rs): one process, but another native prebuild per platform, like `node-datachannel` today.

Gains: the 28 MiB WebTorrent import and its 180 transitive packages go away (including `node-datachannel` and its install script), piece caching becomes explicit, and per-byte CPU drops by a large factor, which is the one improvement no Node change can give. Node's fixed cost stays. Risks: matching today's behaviour that the peer suite pins down (stalled-reader cancellation, exact piece-boundary progress, dead-swarm retries, the cache eviction and seeding rules), and the library's maturity for the streaming patterns `/raw` and `/tar` use.

### D. Rewrite the server in Rust (2–4 months for parity)

Scope is the server and its packages, about 7,900 lines of TypeScript without tests (`apps/server` 2.1k, `playback` 2.5k, `indexers`, `torrent-engine` and `api-contract` about 0.9k each, the rest smaller).

| Area | Rust path | Difficulty |
| --- | --- | --- |
| HTTP, Range, caching, `/raw`, `/tar`, speed test | axum/hyper; `seekable-tar` is 100 lines | Low |
| Indexers (Torznab XML, Prowlarr, BitMagnet GraphQL) | reqwest and quick-xml, with the same same-server redirect and body caps | Low |
| Settings store, status registry, config | serde; the atomic file write | Low to medium |
| Torrent engine | librqbit (option C) | Medium |
| Probe and keyframe index | Matroska and MP4 parsing is already largely our own code (`keyframes.ts`, `mp4.ts`, `matroska-tracks.ts`) and ports directly; Mediabunny's demuxers need Rust equivalents for MPEG-TS and the audio containers | Medium |
| HLS sessions (865 lines) | A port of the segment plan, run management and fragment splitting; the timestamp rules in [HLS streaming](../architecture.md#hls-streaming) are hard-won and the e2e sync test must pass unchanged | High (correctness, not size) |
| Node remux (no ffmpeg, no MSE: mainly iPhones on the core image) | Needs an AAC encoder and AC-3/E-AC-3/DTS decoders; there is no mature pure-Rust AC-3 or DTS decoder, so this means linking libavcodec (ffmpeg again) or dropping the mode and relying on browser remux | High, or drop |
| Shared contract with the client | `api-contract` types and the settings `validate()` run on both sides; Rust needs codegen (ts-rs or typeshare) for types and a second validator, or the validator compiled to WASM for the client | Medium, and a lasting cost |
| Observability | `tracing` and the `prometheus` crate | Low |

Gains: idle around 10–25 MiB resident, one static binary of roughly 10–20 MB, a core image a fraction of today's 40 MB download, no `node_modules`, and the CPU gains of option C. What helps the rewrite: the peer suite (`tests/integration`) and the Playwright suite drive the server over HTTP, so they can serve unchanged as the parity suite.

Costs: everything that took the existing code a dozen checkpoints to get right is re-verified; the client and server stop sharing one language and one set of types; and the [desktop direction](../architecture.md#desktop-distribution-direction) chose Electron with the backend in Electron's Node utility process, which a Rust backend would change into a bundled native sidecar (workable, but the desktop plan would need revisiting).

## Comparison

| | A. Node fixes | B. Bun | C. Rust torrent engine | D. Rust server |
| --- | --- | --- | --- | --- |
| Idle memory | ~45–50 MiB anon (unchanged) | maybe −10 to −30 MiB | −25 to −30 MiB | ~10–25 MiB total |
| Playback peak | bounded; −100+ MiB vs. today's piece cache | same as A | same as A, explicit cache | lowest |
| CPU per downloaded byte | unchanged | ~unchanged | much lower | much lower |
| Effort | days | 1-day spike, then days–weeks | 1–3 weeks | 2–4 months |
| Risk | low | medium (dns, fd 3, perf_hooks, native modules) | medium | high |
| Keeps shared TS contract | yes | yes | yes | no |
| Image size | unchanged | similar (Bun binary vs. Alpine nodejs) | smaller (no WebTorrent tree) | much smaller |

## Recommendation

1. Do option A first, starting with `storeCacheSlots`. It is the largest memory win available, it is hours of work, and every other option needs it anyway (the cache would be just as large in any language until someone bounds it).
2. Run roadmap item 4 on the MikroTik host after A, recording memory and `/raw` throughput with real peers. That measurement decides whether anything further is needed.
3. If throughput is CPU-bound there, do option C. It is the only step that addresses per-byte CPU, it sits behind an existing interface, and it is reversible.
4. Skip Bun unless a spike after A shows a clear idle saving with the mDNS and HLS producer paths intact; its gain is the smallest and its risks hit exactly the parts that are hardest to test.
5. Consider option D only if C succeeds and a single small binary becomes a goal of its own (for example for the desktop app or very small hosts). Decide beforehand whether the Node remux mode is dropped, since it is the one part without a good Rust path.

## Open measurements

- Resident memory with one 1080p and one 4K torrent streaming, before and after `storeCacheSlots`, on arm64.
- `/raw` throughput and Node CPU on the MikroTik host with real peers.
- If B is spiked: idle and playback memory under Bun on arm64 musl, and the peer suite's result.
