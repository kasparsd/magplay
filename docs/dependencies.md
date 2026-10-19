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

Plus `ffmpeg`/`ffprobe` from Alpine Linux.

WebTorrent pulls in about 180 transitive packages, mostly from the WebTorrent
project (feross, mafintosh, jhiesey, ThaUnknown…) and common Node utilities.
`npm ls --omit=dev --all` lists them all. One is worth knowing about:
`node-datachannel` (Murat Doğan) is a native WebRTC module that WebTorrent
loads at startup even though magplay doesn't use WebRTC. Its install script
downloads a prebuilt binary during `npm ci`, which is why the Dockerfile runs
install scripts. uTP is turned off (it would share the DHT's UDP port), so
`utp-native` prints a harmless "Cannot find module" warning at startup on
Linux.

See also the README's [Development](../README.md#development) section.