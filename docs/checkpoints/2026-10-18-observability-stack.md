# Local observability stack validation — 2026-10-18

## Scope

Validated the optional `observability` Compose profile after the structured logging/metrics implementation. This is local-container evidence, not a claim about production-server capacity, browser playback timing or long-session resource behavior.

## Command

```sh
npm run test:observability
```

The acceptance script creates an isolated Compose project with random loopback ports and a temporary Docker subnet. It builds magplay, starts the profile, then removes every container, network and named volume with `docker compose down --volumes --remove-orphans` in a `finally` block.

## Observed result

The command completed successfully with these checks:

- Prometheus scraped magplay's opt-in private metrics listener across the internal `observability` network.
- Alloy discovered only the current Compose project's `magplay` container, parsed its JSON stdout and delivered structured records to Loki.
- Grafana reached both provisioned data sources and loaded the nine-panel `Magplay overview` dashboard.

The profile limits Prometheus to 7 days or 1 GB, Loki to 72 hours with capped ingestion/streams, and gives the local backends explicit CPU/memory limits. Grafana is bound to loopback; Docker socket access by Alloy remains a trusted-development-host boundary.

## Remaining acceptance

The separate real-server/device measurements in [the structured logging plan](../plans/structured-logging.md) remain pending. The isolated stack proves collection and provisioning, not sustained server performance or viewer experience.
