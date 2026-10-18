# magplay

## 0.0.0

### Minor Changes

- The top bar shows whether the server needs attention. Settings edits sources, playback, connection, storage and debug in the browser. A value set by an environment variable stays read-only. The page lists only controls people tune, and the form to add a source is open when none is configured.
- Direct, remux and transcode playback use the same controls on the video, including in fullscreen. The video is sized to the viewport. While a file is converting, the player can show ffmpeg's frame rate and CPU share, and a Performance graph compares playback with conversion.
- While a video is waiting, the player states the cause, the evidence and a relevant action. An intentional pause is not described as buffering.
- Pasting a BitTorrent v1 magnet looks up that torrent without a configured indexer and keeps its name, trackers and web seeds.
- Indexer addresses can use `.local` names, resolved through the host's avahi-daemon when its socket is mounted. Public torrent traffic can be routed through a Gluetun VPN while the web UI stays on the local network.
- Server logs are structured and include the application version. Debug shows a bounded recent log tail, and metrics can be enabled on a private port. An optional local Compose profile can collect those signals for development. It is not part of a normal deployment.

### Patch Changes

- Seeking past the part already converted restarts conversion there.
- Search, Explore and torrent pages keep filters, menus, titles and counts readable. Search filters appear only once there is a query.
- Conversions, torrent loads, probes and subtitle jobs stop at their limits. A full disk stops new conversions, and shutdown stops accepting requests. Diagnostics do not include secrets.
