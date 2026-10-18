# Local Docker acceptance

Run from a development checkout with Docker, ffmpeg/ffprobe and npm dependencies installed:

```sh
docker build -t magplay:local-acceptance .
node tools/scripts/check-docker.mjs
```

The script also verifies structured correlated playback logs, sanitized Debug, the private metrics listener, the bounded local Docker logging driver and final JSON records after graceful SIGTERM. It generates original small media, starts an isolated non-root container on an ephemeral loopback port, installs only its fixture cache, and checks health, torrent verification, ffprobe, a 1 KB byte range, direct MP4 selection, AC3/MKV HLS remux, a restart at 30 seconds and session deletion. It removes its container and temporary files even on failure. It does not alter the Compose stack or existing media cache.

## Recorded local results

The latest local validation is recorded in [the dated checkpoint](checkpoints/2026-10-17-local-validation.md). Results from the tiny warm synthetic fixture do not establish real-world playback latency, sustained throughput, browser rendering, large-file hashing behavior, or server capacity. The container check also verifies that frontend modules are served and colocated test files are excluded from the image.

## Still required on the server

Use the server's normal Docker deployment and representative media. Record:

- Cold and warm startup/seek latency for MP4 direct and MKV/AC3 remux.
- Peak and sustained process CPU/memory, ffmpeg speed and free disk space.
- Long playback, pause-ahead behavior, abandoned tab cleanup and disk-pressure errors.
- A cached large torrent's hash-verification time, and an uncached local-seed transfer.
- Browser/device behavior, including Firefox/Safari or external players actually used.
- A source URL with a `.local` name, with the host's `/run/avahi-daemon` mounted: the startup log says `Resolving .local names through the host’s avahi-daemon` and the source check passes ([plan](plans/mdns-resolution.md)).
- For an optional VPN deployment, complete the [VPN routing and disconnect checks](vpn.md#ports-and-verification) for the selected LAN-host or shared Gluetun topology.

No server address or access has been provided, so this remains a manual acceptance gate, not a claimed completed test.
