# Plan: a static browser client that converts media itself

Goal: host magplay's pages as a static client that talks to the index API, uses a JavaScript torrent client in the browser, and remuxes or transcodes files with browser technologies instead of ffmpeg on the server.

## Where things stand now

The server does all the work:

- `src/torrents.js` runs WebTorrent over TCP and the DHT.
- `src/media.js` runs ffprobe and picks direct, remux or transcode.
- `src/sessions.js` runs ffmpeg into HLS.

The pages in `public/` are already plain static files with no build step. They use relative URLs (`public/lib/urls.js`) and assume the API is on the same origin.

## The main obstacle: torrents in the browser

- **Browsers can't reach normal BitTorrent peers.** They have no TCP, UDP or DHT, only WebRTC. Almost every peer in public swarms uses TCP or uTP. libtorrent added WebTorrent support, but there is no confirmation that qBittorrent ships with it turned on.
- **Most magnets can't even load.** BitMagnet magnets are usually just an infohash, and without the DHT a browser can't fetch the file list.
- **So the server has to stay the bridge.** It already can: WebTorrent 3 in Node loads `node-datachannel`, so it can be a WebRTC peer. It just doesn't announce to a `wss://` tracker yet. The other route is a BEP-19 webseed served from `/raw`-style URLs.

Either way, the server still downloads from the swarm. A browser torrent client only pays off when several tabs or devices share pieces with each other, or when the server is used remotely. For one viewer on the LAN, it adds overhead without saving anything.

## Options for converting in the browser

| Option | Verdict |
|---|---|
| **ffmpeg.wasm** | Remuxing works, but it's slow, has memory limits and handles streaming input badly. Decoding plus re-encoding 1080p video is far below real time. Threads need COOP/COEP headers. |
| **Mediabunny + WebCodecs** | **Best fit.** Pure TS, reads MKV/MP4/WebM, writes MP4/CMAF, and reads over Range requests. AC-3/E-AC-3 and DTS decode through the [`@mediabunny/ac3`](https://mediabunny.dev/guide/extensions/ac3) and `@mediabunny/dts` WASM extensions ([formats](https://mediabunny.dev/guide/supported-formats-and-codecs)). TrueHD isn't listed. |
| **libav.js / web-demuxer** | Workable, but heavier and more glue code than Mediabunny. |

What the browser can realistically convert:

- **Cheap:** changing the container (MKV to fragmented MP4) and converting the audio (AC3/DTS to AAC or Opus). This is exactly what the server's remux mode does today.
- **Not realistic:** converting video the browser can't decode, such as HEVC in Firefox or Hi10P H.264. It would need software decoding in WASM, which is too slow for 1080p. And where WebCodecs can decode HEVC, the browser's normal media pipeline (MSE) usually plays it already. External players remain the answer for those files.

## Hosting the client separately from the server

- **HTTPS:** an HTTPS page can't call `http://media-server:3382` (mixed content), so the API needs TLS.
- **Local network prompt:** Chrome now asks the user before a public site can reach a private IP ([Local Network Access](https://developer.chrome.com/blog/local-network-access)).
- **CORS** on the API, including `Range` and `Content-Range` on `/raw`.
- **Auth:** the server has no login, so an exposed API needs a token. Indexer API keys already stay on the server.
- **No COOP/COEP needed** if threaded ffmpeg.wasm is avoided.

## Suggested approach

### Phase 0: split client and API (small)

Make the API address configurable in `api()` and `urls`, then add CORS, a token and TLS guidance. The pages then work from any static host.

### Phase 1: remux in the browser (the real win)

Add a client-side remux mode to the player:

- Mediabunny reads `/raw` over Range requests, copies the video, converts the audio to AAC or Opus, and feeds fragmented MP4 to MSE.
- Probing can move into the browser too.
- The server then does no ffmpeg work for remux-class files, so the 4-minute pause-ahead throttle and the HLS session directories aren't needed for them.
- Keep server ffmpeg as a fallback.

To test in a spike: how Mediabunny's fragmented MP4 output plugs into a SourceBuffer, and seeking within it. Use the AC3 MKV fixture.

### Phase 2: torrents in the browser (optional)

- Run a `bittorrent-tracker` WebSocket server inside the same Node process, and have the server announce every torrent there as a WebRTC peer.
- The browser runs WebTorrent and reads files through its service-worker server, which gives Mediabunny ordinary URLs to read.
- Using the server outside the LAN needs STUN/TURN. Chrome's mDNS ICE candidates may also complicate connections on the LAN.

### Not planned: converting video in the browser

At most, offer an opt-in low-resolution WASM fallback.

## Recommendation

Phase 1 alone delivers "the browser converts, the server only serves bytes" with very little added complexity. Do Phase 2 only if several viewers sharing pieces or remote use matter.
