# Local validation — 2026-10-17

Implementation through `9d33199` plus the final Docker packaging assertions was validated on the development machine. This is evidence, not the canonical roadmap or a NAS performance claim. The shared working tree also contained unrelated example/indexer edits; these were preserved and are not part of the implementation commits listed in the feature plan.

## Automated checks

- Node 22: 108 fast colocated tests passed, zero failures/skips/cancellations.
- Node 22: loopback TCP/HTTP-tracker suite passed all three scenarios (four runner entries including their parent).
- Node 22: all 19 Chromium playback tests passed, including resume/restart, lifecycle, blocked storage, overload and cache behavior.
- The fast/peer/browser checks also passed on the main local Node 26 runtime during implementation. Earlier helper checks passed on Node 24.
- Syntax and whitespace checks passed.

## Docker

`docker build -t magplay:local-acceptance .` and `node scripts/check-docker.mjs` passed against the final local Linux/arm64 image, running as `node`.

Verified health, served frontend modules, exclusion of colocated tests from the production image, cached torrent verification, ffprobe, a raw byte range, direct MP4 selection, AC3/MKV HLS bytes, restart at 30 seconds and session cleanup.

| Tiny cached synthetic fixture | Baseline | Final run |
| --- | --- | --- |
| First remux segment | 335 ms | 219 ms |
| Restart at 30 seconds, first segment | 221 ms | 214 ms |
| End-of-test CPU snapshot | 0.05% | 0.19% |
| End-of-test memory snapshot | 108.4 MiB | 96.62 MiB |

The runs are not a controlled performance comparison. Their workloads/cache conditions differ; the CPU/memory values are snapshots, not peaks or sustained load. Do not infer a speedup from them.

## Not verified

Actual NAS hardware, amd64 container execution, real-world/public swarms/NAT, current Firefox/Safari/external-player behavior, proxy offload performance, long-film disk pressure, and browser BFCache eligibility. Follow [deployment acceptance](../deployment-acceptance.md) for the remaining device check.
