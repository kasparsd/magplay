# VPN deployment

magplay runs the torrent client on the server. To have public peers, DHT nodes and trackers see a VPN exit address, route the magplay container through a VPN such as [Gluetun](https://github.com/passteque/gluetun). Putting only the browser or BitMagnet behind a VPN does not route magplay's torrent connections through it.

With `network_mode: "service:gluetun"`, magplay shares Gluetun's network stack. Its outgoing connections use the VPN except for loopback, directly connected networks and configured local exceptions. This includes indexer requests as well as torrent connections. The web UI remains reachable through a port published on Gluetun; requests from your browser and their replies stay local.

## Choose the indexer connection

| Where BitMagnet runs | magplay's indexer URL | Local outbound exception |
|---|---|---|
| On another LAN host | `http://192.168.1.50:3333/torznab/api` | Allow that host with `FIREWALL_OUTBOUND_SUBNETS=192.168.1.50/32`. |
| Sharing Gluetun's network stack with magplay | `http://127.0.0.1:3333/torznab/api` | None: the request uses loopback. |
| In a separate container on a Docker network attached to Gluetun | BitMagnet's address on that network, port `3333` | No additional outbound subnet exception for that directly connected network; hostname resolution must also work. |

Running on the same physical server alone does not make `127.0.0.1` work. Both applications must share the network stack for the second case. These patterns also apply to Jackett and Prowlarr, using their own API URLs and keys.

## BitMagnet on another LAN host

Use the standalone [VPN Compose example](../tools/docker/compose.vpn.yml). Replace `192.168.1.50` in both the indexer URL and `FIREWALL_OUTBOUND_SUBNETS` with your BitMagnet host's address. Set `VPN_SERVICE_PROVIDER`, `OPENVPN_USER` and `OPENVPN_PASSWORD` in a local env file, then start it from the repository root:

```sh
docker compose --env-file .env.vpn -f tools/docker/compose.vpn.yml up -d
```

This example uses OpenVPN. Follow [Gluetun's provider setup](https://github.com/qdm12/gluetun-wiki/tree/main/setup/providers) for your provider's required credentials, server selection or WireGuard configuration. The example follows Gluetun's `v3` and magplay's `edge` tags; pin exact releases for a fixed deployment. It is a standalone alternative to the repository's default Compose stack, rather than an override to merge into it.

```text
Browser / external player -- LAN:3382 --> magplay
                                          |-- local exception --> BitMagnet:3333
                                          `-- VPN tunnel -------> peers / DHT / trackers
```

The `/32` exception permits outgoing connections to that one host outside the VPN. Keep exceptions narrow and avoid overlap with the VPN's tunnel address range. The example uses a literal IP so it does not depend on local DNS. A hostname must resolve inside the container; DNS rebinding protection may need an exemption for names resolving to private addresses. For `.local` names, the README's avahi socket setup is also required, and the resolved address still needs the routing exception. See [Gluetun's firewall options](https://github.com/qdm12/gluetun-wiki/blob/main/setup/options/firewall.md).

BitMagnet's own crawling uses its own network configuration. This setup changes magplay's traffic only.

## BitMagnet and magplay sharing Gluetun

If you already use [BitMagnet's Gluetun Compose deployment](https://github.com/bitmagnet-io/bitmagnet/blob/main/docker-compose.yml), add magplay to that same Compose project. Both services use `network_mode: "service:gluetun"`, so magplay reaches BitMagnet on loopback:

```yaml
# Add under services in the existing BitMagnet/Gluetun Compose file:
  magplay:
    image: ghcr.io/kasparsd/magplay:edge
    restart: unless-stopped
    network_mode: "service:gluetun"
    depends_on:
      gluetun:
        condition: service_healthy
    environment:
      TORZNAB_URL: "http://127.0.0.1:3333/torznab/api"
      TORZNAB_NAME: "BitMagnet"
      TORRENT_PORT: "6881"
      LSD_ENABLED: "false"
    volumes:
      - magplay_data:/data

# Add under the existing top-level volumes mapping (create it if absent):
volumes:
  magplay_data:
```

Also add `"3382:8080"` to the existing Gluetun service's `ports` list, keeping BitMagnet's existing ports. If you configured `FIREWALL_INPUT_PORTS`, include `8080` in its list. Open magplay at `http://example-host:3382/` and BitMagnet at `http://example-host:3333/`. Do not add `ports` or `networks` to the magplay service when using `network_mode`.

No `FIREWALL_OUTBOUND_SUBNETS` entry is needed for magplay's loopback request to BitMagnet. Both applications' public torrent traffic goes through the shared VPN. Their internal listening ports must differ: the upstream BitMagnet example uses `3334` for torrents, while magplay uses `6881`.

BitMagnet's upstream example also puts Postgres on Gluetun's directly connected Docker network and supplies its hostname mapping. Gluetun already allows that connected subnet; this differs from initiating a connection to a separate LAN host. See [Gluetun's firewall implementation](https://github.com/passteque/gluetun/blob/master/internal/firewall/enable.go) and [container connection instructions](https://github.com/qdm12/gluetun-wiki/blob/main/setup/connect-a-container-to-gluetun.md).

## Ports and verification

Publish the web port on Gluetun because it owns the shared network stack. Publishing a Docker port and forwarding an incoming port at the VPN provider are separate operations. The standalone example uses outgoing torrent connections without publishing `6881` on the host. Incoming torrent connectivity requires provider-supported forwarding, matching `TORRENT_PORT` inside magplay and the corresponding Gluetun VPN firewall allowance. A provider that changes the forwarded port needs additional coordination with magplay's startup configuration. Do not forward the web UI through the VPN provider; magplay has no login. See [Gluetun port mapping](https://github.com/qdm12/gluetun-wiki/blob/main/setup/port-mapping.md) and [VPN port forwarding](https://github.com/qdm12/gluetun-wiki/blob/main/setup/advanced/vpn-port-forwarding.md).

`LSD_ENABLED=false` disables local multicast peer discovery in these examples. DHT stays enabled and uses the VPN for public traffic.

Before relying on a deployment, verify the following with your provider and network:

- Open the web UI from a LAN browser and check the BitMagnet source in magplay's status menu.
- Check the public exit IP from the shared network stack and confirm it belongs to the VPN.
- With a permitted, uncached torrent, verify metadata and piece transfer through the tunnel.
- Interrupt the VPN tunnel while keeping Gluetun's firewall enabled, and confirm public connections and uncached torrent transfers stop. Cached playback can continue and is not evidence of a leak. A Compose health dependency gates startup; the firewall provides the runtime protection.
- Restore the tunnel and confirm source access and torrent transfers recover. If recreating Gluetun, recreate the containers sharing its network stack too.

The examples have configuration validation only; live VPN routing, DNS, disconnect protection and playback remain deployment acceptance checks.
