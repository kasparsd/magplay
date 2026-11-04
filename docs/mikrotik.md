# Running on a MikroTik router

`ghcr.io/kasparsd/magplay-core` is meant for RouterOS's container runtime: no ffmpeg, about 107 MB unpacked and 37 MB to pull, and nothing it plays is transcoded. The full `magplay` image runs too, but a router's CPU cannot transcode, so there is no reason to use it there.

**Status: not yet run on a router.** What follows is the image's side checked against MikroTik's manual and forum reports, plus the steps the manual gives for any container. The device run is [roadmap](roadmap.md) item 4, and the points marked *unverified* are what it has to settle. Update this page from that run.

## Does the image need special metadata?

No. RouterOS pulls standard OCI images (from Docker Hub, GHCR, Quay and others) and reads the usual config: `ENV`, `CMD`, `WORKDIR` and `USER`. Nothing RouterOS-specific is added to the image. What matters is how it is published:

| Property of the image | Why RouterOS cares |
| --- | --- |
| **`linux/amd64` and `linux/arm64` only.** RouterOS's `arm64` is `linux/arm64` and its `x86` is `linux/amd64`. | RouterOS runs `arm`, `arm64` and `x86`. A 32-bit ARM router (including the `arm32v5` hEX Refresh) cannot run this image: there is no `linux/arm/v7` variant, because the Node 24 build image has none. A wrong architecture shows up as `exec format error` in the container log. |
| **No attestations.** `publish-image.yml` sets `provenance: false`, and SBOM attestations are off by default. | BuildKit's provenance and SBOM attestations add an `unknown/unknown` manifest to the image index. RouterOS's registry pull fails on it (a 404 or `could not load next layer`), the same way for any GitHub-built image. **Keep `provenance: false` and don't enable `sbom`.** |
| **Multi-arch index.** | A registry pull resolves the index to the router's own platform. Only an offline `.tar` needs the architecture picked by hand. |
| **`USER node` (uid 1000), `CACHE_DIR=/data`.** | See [Data and permissions](#data-and-permissions). The one place where the image and RouterOS may disagree. |
| **`ENV NODE_OPTIONS=--max-old-space-size=128`.** | The heap ceiling that keeps Node inside a small memory limit ([container memory](resources.md#container-memory)). Check that RouterOS applied it (see [Verify](#verify)). |
| **`HEALTHCHECK`** (a Docker field). | RouterOS has its own `healthcheck-*` settings and, as far as I found, does not read Docker's. Optional; see below. |
| **No `ENTRYPOINT`, `CMD ["node", "apps/server/src/main.ts"]`, `WORKDIR /app`.** | A forum report says an image's entrypoint was not run by RouterOS. If the container exits at once with no output, set `cmd` and `workdir` explicitly (below). *Unverified for this image.* |

## What the router needs

- RouterOS 7 with the `container` package, on an `arm64` or `x86` device. Containers need RouterOS 7.4 or later; 7.20 or later is a better base, as it added per-container memory limits, `name`, `/container/log`, single-file mounts and string splitting for `cmd`. `restart-policy` needs 7.23. A registry host inside `remote-image` (used below) needs 7.18.
- Container mode, enabled once, with a physical confirmation (the reset button, or a cold reboot on x86) and a reboot: `/system/device-mode/update container=yes`.
- **An external disk** for the container's root directory and temporary extraction, ideally 100 MB/s sequential and 10,000 random IOPS. MikroTik warns against the internal flash, and pulling needs free RAM for extraction.
- Enough RAM. [Container memory](resources.md#container-memory) measured 46 MiB idle and 140-190 MiB while streaming or remuxing, in a 384 MiB limit on arm64 Docker; the router has not been measured. A device with 256 MB total has little room beyond RouterOS itself.
- **DNS.** A container does not start if neither `/ip/dns` nor the container's `dns` is configured.
- A reachable indexer. `.local` source names do not resolve here (no avahi-daemon socket), so use IP addresses or DNS names.

## Setup

Following MikroTik's [container manual](https://manual.mikrotik.com/docs/containers/), with magplay's values. Use your own subnet, disk name and version tag.

```routeros
# One-time network for containers
/interface/veth/add name=veth-magplay address=172.17.0.2/24 gateway=172.17.0.1
/interface/bridge/add name=containers
/ip/address/add address=172.17.0.1/24 interface=containers
/interface/bridge/port/add bridge=containers interface=veth-magplay
/ip/firewall/nat/add chain=srcnat action=masquerade src-address=172.17.0.0/24

# Registry and extraction directory
/container/config/set registry-url=https://ghcr.io tmpdir=disk1/tmp

# Settings: the same variables as the README's table. Secrets here are stored in the router configuration.
/container/envs/add list=magplay key=TORZNAB_URL value="http://192.168.88.50:3333/torznab/api"
/container/envs/add list=magplay key=CACHE_MAX_GB value=20

# Data (see Data and permissions before choosing this)
/container/mounts/add list=magplay-data src=disk1/magplay-data dst=/data

/container/add remote-image=ghcr.io/kasparsd/magplay-core:0.4.2 name=magplay \
  interface=veth-magplay root-dir=disk1/containers/magplay \
  envlists=magplay mountlists=magplay-data \
  logging=yes start-on-boot=yes memory-max=402653184 dns=172.17.0.1
/container/start magplay
```

- Pin a version tag rather than `edge`. RouterOS does not update a container in place: to upgrade, stop and remove it and add it again with the new tag, keeping the mounts. `envlists=` is `envlist=` before 7.20.
- `memory-max=402653184` is the 384 MiB limit the memory notes were measured under, hard, in bytes. It kills the container if it passes it. `memory-high` throttles and reclaims instead of killing and may suit a router better; pick from the device run.
- `logging=yes` sends the server's JSON log to RouterOS's log. `/container/log` (7.20+) keeps the last messages.
- If the container exits immediately, add `cmd="node apps/server/src/main.ts" workdir=/app`.

### Reaching it

The bridge is a routed subnet, so LAN clients may open `http://172.17.0.2:8080/` directly if your firewall forwards LAN traffic to it. To put it on the router's own address instead, with the router at `192.168.88.1`:

```routeros
/ip/firewall/nat/add chain=dstnat dst-address=192.168.88.1 dst-port=3382 protocol=tcp action=dst-nat to-addresses=172.17.0.2 to-ports=8080
```

Peers: outbound connections work through the masquerade rule. Inbound peers and DHT need `6881` forwarded to the container on **both TCP and UDP** from the interface the peers come from, and `TORRENT_PORT` unchanged. Without it, torrents work with fewer peers. For public torrent traffic, see also [the VPN deployment](vpn.md); a VPN on the router is a RouterOS routing matter, not something the container configures.

The write protection against other websites ([architecture](architecture.md)) compares the page's `Origin` or `Sec-Fetch-Site` with the `Host` it was loaded from, so any address that serves the page works, including the router's NAT address.

## Data and permissions

The image runs as `node` (uid 1000) and `/data` in the image is owned by it. RouterOS bind mounts are plain host directories: it has no setting for a mount's uid, gid or mode, and MikroTik's own forum describes mounted directories as owned by root with no write for others. Which of these holds for magplay is **unverified**:

1. **RouterOS runs the image's `USER`:** a freshly created mount is root-owned and `node` cannot write to it, so the server fails at start (cache directory or `settings.json` not writable). Without a mount, `/data` lives in the container's root directory, which is writable.
2. **RouterOS runs the process as root:** it can write anywhere, and a mount works.

So the first run should decide it. Either start without the `mountlists` line and add the mount afterwards, or run the first start and read `/log` for a permission error. If it is one, the choices are, in order of preference:

- Start without the mount. `/data` in the container's `root-dir` on the external disk survives restarts and reboots, and is lost when the container is removed, which an upgrade does. What is lost is the torrent cache and `settings.json`; settings can be given as environment variables instead, and the cache refills.
- Set `user=0` on the container (`/container/set magplay user=0`), if RouterOS then lets the process write the mount. A forum report found `user=0` did not always help for a `chown`; magplay does not `chown`.
- Give a mount an existing directory that already has the right owner, using a path in the container's own image (MikroTik: a source directory that does not exist is filled from the destination's contents on first use).

If a change to the image would make this simpler, such as the entrypoint creating `/data` with open permissions, that belongs in the Dockerfile and this page, after the device run shows which case applies.

## Verify

```routeros
/container/print detail where name=magplay
/log/print where topics~"container"
/container/shell magplay      # then: env | grep NODE_OPTIONS ; id ; touch /data/x && rm /data/x
```

From a LAN host: `curl http://172.17.0.2:8080/health` returns `{"ok":true,...}`, and Settings → Debug shows the ffmpeg check as a warning (expected on `magplay-core`).

Optional health check, the equivalent of the image's Docker `HEALTHCHECK`, which RouterOS may not read:

```routeros
/container/set magplay healthcheck-cmd="node -e \"fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))\"" healthcheck-interval=30s stop-on-unhealthy=yes
```

## If it does not start

| Symptom | Likely cause |
| --- | --- |
| Pull fails with a 404, `could not load next layer` or an unsupported manifest | An image published with attestations. Check `publish-image.yml` still has `provenance: false`. As a workaround, `docker pull --platform linux/arm64`, `docker save`, upload the tar and `/container/add file=...`. |
| `exec format error` in the log | Wrong architecture: a 32-bit ARM router, or a tar saved for another platform. |
| The container is added but never starts | No DNS configured, container mode not enabled, or the extraction directory is out of space. |
| Starts, then exits at once with no output | The entrypoint was not run: set `cmd` and `workdir` as above. |
| Exits with a permission error on `/data` or `settings.json` | See [Data and permissions](#data-and-permissions). |
| Killed after a while, `memory-max` reached | Raise it, or lower the load (fewer simultaneous streams, a smaller `CACHE_MAX_GB`); see [container memory](resources.md#container-memory). |
| The UI loads, search finds nothing | The indexer address is not reachable from the container's subnet, or it is a `.local` name. |

## Sources

- [RouterOS container manual](https://manual.mikrotik.com/docs/containers/) and [the container CLI reference](https://manual.mikrotik.com/docs/cli-reference/container/).
- [MikroTik forum: attestations break pulls](https://forum.mikrotik.com/t/import-adguard-dns-container-image-problem/164536), [non-root containers and volumes](https://forum.mikrotik.com/t/non-root-container-and-volume/177963).
- [Container limitations](https://tangentsoft.com/mikrotik/wiki?name=Container+Limitations) (a community write-up of how RouterOS differs from Docker).
