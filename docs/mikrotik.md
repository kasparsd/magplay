# Running on a MikroTik router

`ghcr.io/kasparsd/magplay-core` is meant for RouterOS's container runtime: no ffmpeg, about 107 MB unpacked and 37 MB to pull, and nothing it plays is transcoded. The full `magplay` image runs too, but a router's CPU cannot transcode, so there is no reason to use it there.

**Status: run on an emulated router, not on hardware.** The image was pulled from GHCR, started and used on RouterOS 7.25.1 (an ARM64 CHR virtual machine under QEMU on a Mac, see [Testing without a router](#testing-without-a-router)). That settled the image's metadata, user, permissions and DNS questions below. The `linux/arm/v7` image was also imported from a tarball and ran healthy on that arm64 router, which executes 32-bit containers (RouterOS reported `arch: arm`, 52 MiB at start); a 32-bit router's kernel is a different thing, so that is evidence, not proof. Not yet done, and the reason roadmap item 4 stays open: a physical router, real peers, a playback, and memory or throughput numbers (an emulated CPU says nothing about speed).

## Does the image need special metadata?

No. RouterOS pulls standard OCI images and reads the usual config. On 7.25.1 it read this image's `CMD`, `ENV`, `USER node`, `WORKDIR /app` and Docker `HEALTHCHECK` with no settings of its own (`/container/print detail` shows them as `default-cmd`, `default-user`, `default-workdir` and `default-healthcheck-cmd`). What matters is how the image is published:

| Property of the image | Why RouterOS cares |
| --- | --- |
| **`linux/amd64`, `linux/arm64` and (core only) `linux/arm/v7`.** RouterOS's `arm64` is `linux/arm64`, `arm` is `linux/arm/v7` and `x86` is `linux/amd64`. | RouterOS runs `arm`, `arm64` and `x86`. A router older than ARMv7 cannot run the image, because Node 24 needs ARMv7; that includes the `arm32v5` hEX Refresh. A wrong architecture shows up as `exec format error` in the container log. |
| **No attestations.** `publish-image.yml` sets `provenance: false`, and SBOM attestations are off by default. | BuildKit's provenance and SBOM attestations add an `unknown/unknown` manifest to the image index. RouterOS's registry pull fails on it (a 404 or `could not load next layer`) for any GitHub-built image. The published `edge` index pulled cleanly. **Keep `provenance: false` and don't enable `sbom`.** |
| **Multi-arch index.** | A registry pull resolves the index to the router's own platform; verified for `arm64`. Only an offline `.tar` needs the architecture picked by hand (`docker save --platform linux/arm/v7 ...`). |
| **`USER node` (uid 1000), `CACHE_DIR=/data`.** | RouterOS runs the process as `node` (checked: `uid=1000`). See [Data and permissions](#data-and-permissions). |
| **`ENV NODE_OPTIONS=--max-old-space-size=128`.** | Applied (checked inside the container). This is the heap ceiling that keeps Node inside a small memory limit ([container memory](resources.md#container-memory)). |
| **`HEALTHCHECK`** | RouterOS reads it: a running container reports `healthcheck-status: good`. `stop-on-unhealthy=yes` makes RouterOS stop it when the check fails. |

## What the router needs

- RouterOS 7 with the `container` package, on an `arm`, `arm64` or `x86` device (32-bit `arm` means ARMv7 or newer). Containers need RouterOS 7.4 or later; tested on 7.25.1. 7.20 added per-container memory limits, `name` and `/container/log`; `restart-policy` needs 7.23. A registry host inside `remote-image` (used below) needs 7.18.
- Container mode, enabled once, with a physical confirmation (the reset button, or a cold reboot on x86 and CHR) and a reboot: `/system/device-mode/update container=yes`.
- **An external disk** for the container's root directory and temporary extraction, ideally 100 MB/s sequential and 10,000 random IOPS. MikroTik warns against the internal flash, and pulling needs free RAM for extraction.
- Enough RAM. The container used 54-70 MiB right after starting on the emulated router. [Container memory](resources.md#container-memory) measured 140-190 MiB while streaming or remuxing, in a 384 MiB limit on arm64 Docker. A device with 256 MB total has little room beyond RouterOS itself.
- **DNS the container can use.** See [DNS](#dns). Without it the container starts but cannot resolve indexer or tracker names.
- A reachable indexer. `.local` source names do not resolve here (no avahi-daemon socket), so use IP addresses or DNS names.

## Setup

Following MikroTik's [container manual](https://manual.mikrotik.com/docs/containers/), with magplay's values. Use your own subnet, disk name and version tag. These commands, in this order, took a blank CHR to a running, healthy container.

```routeros
# One-time network for containers
/interface/veth/add name=veth-magplay address=172.17.0.2/24 gateway=172.17.0.1
/interface/bridge/add name=containers
/ip/address/add address=172.17.0.1/24 interface=containers
/interface/bridge/port/add bridge=containers interface=veth-magplay
/ip/firewall/nat/add chain=srcnat action=masquerade src-address=172.17.0.0/24

# DNS for containers (see DNS: the router answers them, and only them)
/ip/dns/set allow-remote-requests=yes
/ip/firewall/filter/add chain=input in-interface=containers protocol=udp dst-port=53 action=accept
/ip/firewall/filter/add chain=input in-interface=containers protocol=tcp dst-port=53 action=accept

# Registry and extraction directory
/container/config/set registry-url=https://ghcr.io tmpdir=disk1/tmp

# Settings: the same variables as the README's table. Secrets here are stored in the router configuration.
/container/envs/add list=magplay key=TORZNAB_URL value="http://192.168.88.50:3333/torznab/api"
/container/envs/add list=magplay key=CACHE_MAX_GB value=20

# Data (see Data and permissions)
/container/mounts/add list=magplay-data src=disk1/magplay-data dst=/data

/container/add remote-image=ghcr.io/kasparsd/magplay-core:0.4.2 name=magplay \
  interface=veth-magplay root-dir=disk1/containers/magplay \
  envlists=magplay mountlists=magplay-data \
  logging=yes start-on-boot=yes memory-max=402653184
/container/start magplay
```

- Pin a version tag rather than `edge`. RouterOS does not update a container in place: to upgrade, stop and remove it and add it again with the new tag, keeping the mounts. `envlists=` is `envlist=` before 7.20.
- The pull downloads and extracts about 40 MB of layers; with a fast link it took about 20 seconds on the emulated router. The container is added stopped, so start it.
- `memory-max=402653184` is the 384 MiB limit the memory notes were measured under, hard, in bytes. It kills the container if it passes it. `memory-high` throttles and reclaims instead of killing and may suit a router better; pick from a device run.
- `logging=yes` sends the server's JSON log to RouterOS's log. `/container/log` (7.20+) keeps the last messages.
- Starting up logs a `Cannot find module` stack from `utp.cjs`. That is the known, harmless uTP warning ([dependencies](dependencies.md)), not a failure.

### DNS

By default RouterOS points a container's `resolv.conf` at the veth's gateway (`172.17.0.1` here), so the router has to answer DNS for the container. That needs `/ip/dns/set allow-remote-requests=yes`; the router's default is `no`, and then every lookup fails with `Connection refused` while the container itself runs fine. Setting `dns=172.17.0.1` on the container does not help, and leaving `dns` empty does not change what the container uses.

`allow-remote-requests=yes` makes the router answer DNS from any interface its firewall lets reach it. MikroTik's default firewall already drops DNS from the internet, but the container bridge is not in the default `LAN` interface list, so the two `input` rules above let it in (on a router with the default firewall, move them above its final `drop` rule; on the emulated router's empty firewall, plain `add` worked). Keep your WAN input rules intact. Alternatively give the container a real resolver (`dns=1.1.1.1`, say), at the cost of bypassing the router's DNS.

### Reaching it

The bridge is a routed subnet, so LAN clients may open `http://172.17.0.2:8080/` directly if your firewall forwards LAN traffic to it. To put it on the router's own address instead, with the router at `192.168.88.1`:

```routeros
/ip/firewall/nat/add chain=dstnat dst-address=192.168.88.1 dst-port=3382 protocol=tcp action=dst-nat to-addresses=172.17.0.2 to-ports=8080
```

A request through such a rule (from outside the router) reached the UI, `/api/debug` and `PATCH /api/settings` on the emulated router.

Peers: outbound connections work through the masquerade rule. Inbound peers and DHT need `6881` forwarded to the container on **both TCP and UDP** from the interface the peers come from, and `TORRENT_PORT` unchanged. Without it, torrents work with fewer peers. For public torrent traffic, see also [the VPN deployment](vpn.md); a VPN on the router is a RouterOS routing matter, not something the container configures.

The write protection against other websites ([architecture](architecture.md)) compares the page's `Origin` or `Sec-Fetch-Site` with the `Host` it was loaded from, so any address that serves the page works, including the router's NAT address.

## Data and permissions

The image runs as `node` (uid 1000) and `/data` in the image is owned by it. RouterOS bind mounts have no uid, gid or mode setting. What happened on 7.25.1 with the `mounts/add` above:

- `disk1/magplay-data` did not exist, so RouterOS created it **and filled it from the image's `/data`**, which carried `node:node` ownership with it (MikroTik documents the fill: "if `src` does not exist it is populated with whatever the container has in `dst`"). Inside the container `/data` was `drwxr-xr-x node node`, and `PATCH /api/settings` wrote `settings.json` there, visible from RouterOS as `disk1/magplay-data/settings.json`. The HLS directory was created too. Torrent data goes in the same mount.
- If the source directory **already exists** (made in Winbox or with `/file`), RouterOS does not fill it, and it is owned by root, so `node` could not write to it. Let RouterOS create the directory, or use a new name.
- Without the `mountlists` line, `/data` lives in the container's `root-dir` and is also writable. It survives restarts and reboots but not removing the container, which is what an upgrade does; the torrent cache and `settings.json` would be lost, so keep the mount for anything you want to keep.
- Per MikroTik's forum, a mount whose directory has no `.type` file (the marker RouterOS writes when it creates the directory) is read-only inside the container and read-write from `/file`. Leave the marker alone.

## Verify

```routeros
/container/print detail where name=magplay
/log/print where topics~"container"
/container/shell magplay      # then: id ; env | grep -E 'NODE_OPTIONS|CACHE' ; ls -ld /data ; nslookup github.com
```

From a LAN host: `curl http://172.17.0.2:8080/health` returns `{"ok":true,...}`, and Settings → Debug shows the ffmpeg check as a warning (expected on `magplay-core`). `/container/print` shows `healthcheck-status` from the image's own check.

## If it does not start

| Symptom | Likely cause |
| --- | --- |
| Pull fails with a 404, `could not load next layer` or an unsupported manifest | An image published with attestations. Check `publish-image.yml` still has `provenance: false`. As a workaround, `docker pull --platform linux/arm64`, `docker save`, put the tar on the router (`/tool/fetch` works) and `/container/add file=...`. |
| `exec format error` in the log | Wrong architecture: a pre-ARMv7 router, or a tar saved for another platform. |
| The container is added but never starts | Container mode not enabled (check `/system/device-mode/print`), or the extraction directory is out of space. |
| Starts and serves, but search finds nothing and the log shows `ENOTFOUND` or `EAI_AGAIN` | DNS: see [DNS](#dns). |
| Search shows `ECONNREFUSED` or a timeout for the indexer | The indexer address is not reachable from the container's subnet, or the masquerade rule is missing. |
| Exits with a permission error on `/data` or `settings.json` | A mount whose source directory already existed. See [Data and permissions](#data-and-permissions). |
| Killed after a while, `memory-max` reached | Raise it, or lower the load (fewer simultaneous streams, a smaller `CACHE_MAX_GB`); see [container memory](resources.md#container-memory). |

## Testing without a router

A MikroTik CHR (cloud hosted router) is the RouterOS virtual machine. An **ARM64 CHR runs under QEMU on Apple Silicon**, which is how this guide was checked. It is software emulation, so it is slow, and it does not measure a real router's speed or memory, but it runs the real container runtime. Run it in QEMU directly: a VM inside Docker Desktop needs nested virtualization, and hardware acceleration (`-accel hvf`) did not start RouterOS's CHR here (it ships some 32-bit ARM binaries that Apple Silicon's hypervisor cannot run), so use `-accel tcg`.

```sh
brew install qemu
V=7.25.1
curl -LO https://download.mikrotik.com/routeros/$V/chr-$V-arm64.img.zip && unzip chr-$V-arm64.img.zip
cp /opt/homebrew/share/qemu/edk2-arm-vars.fd vars.fd
qemu-img create -f qcow2 disk1.qcow2 6G          # the "external disk" for containers

qemu-system-aarch64 -M virt -m 1024 -smp 2 -accel tcg,tb-size=512 -cpu cortex-a72 \
  -drive if=pflash,format=raw,readonly=on,unit=0,file=/opt/homebrew/share/qemu/edk2-aarch64-code.fd \
  -drive if=pflash,format=raw,unit=1,file=vars.fd \
  -drive file=chr-$V-arm64.img,format=raw,if=none,id=d0 -device virtio-blk-pci,drive=d0,bootindex=0 \
  -drive file=disk1.qcow2,format=qcow2,if=none,id=d1 -device virtio-blk-pci,drive=d1 \
  -netdev user,id=n0,hostfwd=tcp::9180-:80,hostfwd=tcp::18080-:18080 -device virtio-net-pci,netdev=n0 \
  -display none -monitor none -chardev socket,id=s0,path=serial.sock,server=on,wait=off -serial chardev:s0
```

- Use `-device virtio-blk-pci` for the disks. The `if=virtio` shorthand is an MMIO device on this machine type and RouterOS's kernel stalls on it. It boots in about a minute.
- The VM has internet through QEMU's NAT, so it can reach `ghcr.io`. `10.0.2.2` is the Mac as seen from the VM; `hostfwd` publishes the router's port 80 (the REST API) and 18080 on the Mac.
- Everything above can be driven over the REST API with `curl -u admin: -X POST -H 'Content-Type: application/json' -d '{...}' http://localhost:9180/rest/<menu path>` (a blank `admin` password on a fresh CHR). The serial console (`nc -U serial.sock`) is only needed for `/container/shell`, and asks to change the password first (Ctrl-C skips it).
- Enable the package: `check-for-updates` then `enable` and `apply-changes` under `/system/package` (it reboots). Then start `POST /rest/system/device-mode/update {"container":"yes"}`, leave that request waiting, and **kill and restart QEMU**: a cold reboot is what confirms it, and a `/system/reboot` is not enough.
- A new disk needs `/disk/format` (not `format-drive` on 7.25.1) with `file-system=ext4`; `/disk/set slot=disk1` gives it the name the commands here use.
- For the `dst-nat` rule use `dst-port=18080` on the router and open `http://localhost:18080/` on the Mac.

## Sources

- [RouterOS container manual](https://manual.mikrotik.com/docs/containers/) and [the container CLI reference](https://manual.mikrotik.com/docs/cli-reference/container/).
- [MikroTik forum: attestations break pulls](https://forum.mikrotik.com/t/import-adguard-dns-container-image-problem/164536), [non-root containers and volumes](https://forum.mikrotik.com/t/non-root-container-and-volume/177963).
- [Container limitations](https://tangentsoft.com/mikrotik/wiki?name=Container+Limitations) (a community write-up of how RouterOS differs from Docker).
- [CHR under QEMU and UTM](https://forum.mikrotik.com/t/chr-using-apple-virtualization-qemu-for-linux-ready-to-use/173805) and [`tikoci/mikropkl`](https://github.com/tikoci/mikropkl), for the boot flags.
