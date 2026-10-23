# Dependencies

External npm dependencies are declared in their consuming workspace and pinned
to exact versions.

| Package | Version | Purpose | Maintainers |
|---|---|---|---|
| [`webtorrent`](https://github.com/webtorrent/webtorrent) | 3.0.21 | Torrent client (DHT, trackers, TCP) | WebTorrent project: Feross Aboukhadijeh, Mathias Buus, Diego Rodríguez Baquero, Alex (alxhotel) and others |
| [`parse-torrent`](https://github.com/webtorrent/parse-torrent) | 11.0.24 | Parse magnets and .torrent files (also used inside webtorrent) | WebTorrent project |
| [`fast-xml-parser`](https://github.com/NaturalIntelligence/fast-xml-parser) | 5.11.2 | Torznab XML | Amit Gupta (NaturalIntelligence) |
| [`hls.js`](https://github.com/video-dev/hls.js) | 1.7.3 | HLS playback in Firefox/Chrome, lazy-loaded by the playback controller | video-dev: Rob Walch, Tom Jenkinson, Guillaume du Pontavice |
| `pino` | 10.4.0 | Structured server logging | Pino project |
| `@prometheus-io/client` | 0.16.1 | Metrics registry and collectors | prometheus-io |
| [`react`](https://github.com/facebook/react), `react-dom` | 19.3.0 | All page/control views and controller snapshot subscriptions, bundled | Meta and the React team |
| [`@tanstack/react-router`](https://github.com/TanStack/router) | 1.170.41 | Typed page/search routes, in-app navigation, scroll restoration and lazy Player loading | TanStack: Tanner Linsley, Manuel Schiller and others |
| [`@tanstack/react-query`](https://github.com/TanStack/query) | 5.104.1 | Catalog/metadata caching, visibility-aware polling and Settings mutations; bundled | TanStack: Tanner Linsley, Dominik Dorfmeister and others |
| `vite` | 8.3.4 | Hashed client build, source maps, dev server and same-origin proxy | Vite team |
| `@vitejs/plugin-react` | 6.1.2 | TSX transform and Fast Refresh | Vite team |
| `eslint-plugin-react-hooks` | 7.1.1 | Hook lifetimes and dependency checks for TSX views | React team |
| `@types/react`, `@types/react-dom` | 19.3.0 | Strict TypeScript component and DOM types | DefinitelyTyped |
| [`mediabunny`](https://github.com/Vanilagy/mediabunny) | 1.61.6 | Demuxers for the Node probe, and the copy-and-mux path for browser remux and Node remux | Vanilagy (Vanessa Lagy) |
| `@mediabunny/aac-encoder`, `@mediabunny/ac3`, `@mediabunny/dts` | 1.61.6 | WASM AAC encoder and AC-3/E-AC-3 and DTS decoders. The browser loads a chunk only for the codec it is converting; a Node remux registers all three for the session | Vanilagy |

Plus `ffmpeg` from Alpine Linux in the `magplay` image only; `magplay-core` has no ffmpeg and no other media binary. ffprobe is not used. What a Node remux costs in a container is in [resources](resources.md#container-memory).

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