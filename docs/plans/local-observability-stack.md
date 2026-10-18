# Local observability stack

Requested 2026-10-18 as a follow-up to the logging implementation. Keep the canonical architecture and operating instructions in [logging](../logging.md). Add an optional local Compose profile using Prometheus, Grafana, Loki and Alloy, reusing app JSON/metrics without application exporters or remote credentials.

- [x] Select supported pinned images and an opt-in Compose profile; keep Grafana on loopback and backends on an internal network.
- [ ] Add metrics scrape, Docker log collection, finite retention/resource settings and persistent local volumes.
- [ ] Provision both Grafana data sources and a small playback/resources/logs dashboard.
- [ ] Validate configuration and exercise actual metric/log ingestion in an isolated Compose project, then remove its containers/volumes.
- [ ] Update canonical logging docs and README startup/stop instructions, including the Docker socket permission boundary.
