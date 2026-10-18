# Local observability stack

Requested 2026-10-18 as a follow-up to the logging implementation. Keep the canonical architecture and operating instructions in [logging](../logging.md). Add an optional local Compose profile using Prometheus, Grafana, Loki and Alloy, reusing app JSON/metrics without application exporters or remote credentials.

- [x] Select supported pinned images and an opt-in Compose profile; keep Grafana on loopback and backends on an internal network.
- [x] Add metrics scrape, Docker log collection, finite retention/resource settings and persistent local volumes.
- [x] Provision both Grafana data sources and a small playback/resources/logs dashboard.
- [x] Validate configuration and exercise actual metric/log ingestion in an isolated Compose project, then remove its containers/volumes.
- [x] Update canonical logging docs and README startup/stop instructions, including the Docker socket permission boundary.

## Evidence

`npm run test:observability` creates an isolated Compose project, uses a random loopback Grafana port and temporary named volumes, then proves the private Prometheus scrape, structured Docker-log ingestion in Loki and both provisioned Grafana data sources/dashboard. It always runs `docker compose down --volumes --remove-orphans`; the 2026-10-18 run and limits are recorded in [the dated checkpoint](../checkpoints/2026-10-18-observability-stack.md).
