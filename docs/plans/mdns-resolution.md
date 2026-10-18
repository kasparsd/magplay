# `.local` (mDNS) names in source URLs

Goal: source URLs such as `http://bitmagnet.local:3333/torznab/api` work from the Linux Docker image, not only on a Mac or in Docker Desktop.

## Decision

- mDNS multicast doesn't cross Docker's bridge network, so the container asks the host's avahi-daemon over its socket (`/run/avahi-daemon/socket`, mounted read-only from the host's `/run/avahi-daemon`).
- Resolution lives in the server (`apps/server/src/mdns.ts`), not in the image's libc. Alpine's musl has no NSS, so nss-mdns can't be used. Switching to a Debian base for `libnss-mdns` was tried and rejected: Debian's `ffmpeg` pulls in Mesa and LLVM, and the image grew from 457 MB to 987 MB.
- At startup, when the socket exists, `dns.lookup` is replaced by one that sends `.local` names to avahi (its `RESOLVE-HOSTNAME-IPV4/6` line protocol) and falls back to the original lookup for other names and failed answers. Node's `net`, and so `fetch`, reads `dns.lookup` on every connection; a unit test fetches through it so a Node change that breaks this shows up.
- ffmpeg only reads loopback `/raw` URLs, so it needs no mDNS.

## Todo

- [x] Resolver, tests, startup log line
- [x] Socket mount in `compose.yml` and the README example; README indexer-address note
- [x] Docker check on the rebuilt image; end-to-end in the image with a fake avahi socket
- [ ] Confirm against a real avahi-daemon on the NAS
