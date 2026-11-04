# Dependencies

External npm dependencies are declared in their consuming workspace and pinned
to exact versions.

| Package | Version | Purpose | Maintainers |
|---|---|---|---|
| [`webtorrent`](https://github.com/webtorrent/webtorrent) | 3.0.21 | Torrent client (DHT, trackers, TCP) | WebTorrent project: Feross Aboukhadijeh, Mathias Buus, Diego Rodríguez Baquero, Alex (alxhotel) and others |
| [`parse-torrent`](https://github.com/webtorrent/parse-torrent) | 11.0.24 | Parse magnets and .torrent files (also used inside webtorrent) | WebTorrent project |
| [`fast-xml-parser`](https://github.com/NaturalIntelligence/fast-xml-parser) | 5.11.2 | Torznab XML | Amit Gupta (NaturalIntelligence) |
| [`hls.js`](https://github.com/video-dev/hls.js) | 1.7.3 | HLS playback in Firefox/Chrome, bundled into the client | video-dev: Rob Walch, Tom Jenkinson, Guillaume du Pontavice |
| `pino` | 10.4.0 | Structured server logging | Pino project |
| `@prometheus-io/client` | 0.16.1 | Metrics registry and collectors | prometheus-io |
| [`mediabunny`](https://github.com/Vanilagy/mediabunny) | 1.61.6 | Demuxers for the Node probe, and the copy-and-mux path for browser remux and Node remux | Vanilagy (Vanessa Lagy) |
| `@mediabunny/aac-encoder`, `@mediabunny/ac3`, `@mediabunny/dts` | 1.61.6 | WASM AAC encoder and AC-3/E-AC-3 and DTS decoders. The browser loads a chunk only for the codec it is converting; a Node remux registers all three for the session | Vanilagy |

Plus `ffmpeg` from Alpine Linux in the `magplay` image only; `magplay-core` has no ffmpeg and no other media binary. ffprobe is not used. What a Node remux costs in a container is in [resources](resources.md#container-memory).

WebTorrent pulls in about 180 transitive packages, mostly from the WebTorrent
project (feross, mafintosh, jhiesey, ThaUnknown…) and common Node utilities.
`npm ls --omit=dev --all` lists them all. Two are worth knowing about:

- `webrtc-polyfill` is replaced by a workspace of the same name and version
  (`packages/webrtc-polyfill`). The registry package loads `node-datachannel`,
  a 9 MB native WebRTC addon that WebTorrent's tracker client imports at
  startup even though magplay doesn't use WebRTC. The stub's connections fail
  with an error, which `bittorrent-tracker` reports as a warning, so a `wss://`
  tracker in `EXTRA_TRACKERS` still announces but never gets WebRTC peers.
  Peers connect over TCP and UDP only. Restoring WebRTC means deleting the
  workspace and allowing `node-datachannel`'s install script again.
- uTP is turned off (it would share the DHT's UDP port), so `utp-native` prints
  a harmless "Cannot find module" warning at startup on Linux.

See also the README's [Development](../README.md#development) section.