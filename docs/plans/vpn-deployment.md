# Optional VPN deployment

Goal: explain how Gluetun routes public torrent traffic while keeping the web UI and local indexer requests local.

- [x] Check the upstream BitMagnet Compose example and Gluetun networking/firewall documentation.
- [x] Document separate LAN and shared Gluetun deployments, including the directly connected Docker-network case.
- [x] Add an optional Compose example and link it from a new README VPN section.
- [x] Validate Compose configuration and document the remaining runtime acceptance checks.

Validation: `docker compose config --quiet` passed for the standalone example with dummy provider credentials and for the documented shared-stack fragment with a Gluetun service fixture. No VPN containers were started. Live provider routing, DNS, disconnect protection and playback remain acceptance checks in [the guide](../vpn.md#ports-and-verification).
