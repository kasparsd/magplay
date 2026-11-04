# Image size without node-datachannel — 2026-11-04

linux/arm64, Docker, Alpine 3.24 `nodejs`. Both images were built from the same machine and cache: `main` at `c7c0ead` and the branch that stubs `webrtc-polyfill` ([dependencies](../dependencies.md)). Unpacked is the sum of layer sizes (`docker history`). Pull is the gzip size of `docker save`, an approximation of the registry's compressed size.

| Image | | Unpacked | `node_modules` layer | Pull (approx.) |
| --- | --- | --- | --- | --- |
| `magplay-core` | before | 120.0 MB | 25.2 MB | 39.0 MB |
| `magplay-core` | after | 112.5 MB | 17.6 MB | 36.4 MB |
| `magplay` | before | 227.7 MB | 25.2 MB | not measured |
| `magplay` | after | 220.2 MB | 17.6 MB | not measured |

The saving is 7.5 MB unpacked (about 6% of `magplay-core`) and 2.6 MB to pull, all from the stripped `node_datachannel.node` and its package files. `magplay-core` answered `/health` and logged no WebRTC or missing-module errors. The unit (343) and peer (4) suites pass.
