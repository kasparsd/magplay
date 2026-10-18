# Logging and observability

## Purpose and status

magplay serves one person on a trusted LAN. Observability should help explain failed playback, slow startup/seek, source outages and resource pressure while leaving CPU, memory and disk available for watching. It supports the [roadmap](roadmap.md), [resource safeguards](resources.md) and [lifetime rules](lifecycle.md); it does not introduce a monitoring product or change those boundaries.

This document owns the architecture and operating principles. Implemented on 2026-10-18: injected structured logging, independent application metrics, an optional private metrics listener and a bounded structured Debug tail. Console capture has been removed. Local verification is recorded in [the logging checkpoint](checkpoints/2026-10-18-logging.md) and [the observability stack checkpoint](checkpoints/2026-10-18-observability-stack.md); actual server/device measurements remain separate acceptance work.

## Design principles

[Datadog's observability guide](https://www.datadoghq.com/knowledge-center/observability/) distinguishes detecting known problems from investigating why a system behaves a certain way. It emphasizes correlation across signals, deployment/configuration changes, user experience, and deliberate control of volume and overhead. Applied here, start with diagnostic questions and connected logs/metrics; add another signal only when it answers an unresolved question. This is an application of the guide, not a decision to install Datadog or reproduce its platform.

| Question | Evidence to connect |
| --- | --- |
| Why did this playback fail? | Request → preparation → shared probe/torrent job → HLS session, with a final outcome and reason. |
| Why is startup or a seek slow? | Server stage durations, warm/cold cache evidence and published playable output, compared with the browser's actual buffer/frame evidence. |
| Is the server overloaded or waiting for data? | Slot occupancy, resource rejection, free space, job durations and available conversion/torrent status; record uncertainty rather than infer CPU overload from low ffmpeg speed. |
| What changed before a regression? | App version/run, startup and shutdown, and saved setting key names with a per-run configuration revision; never setting values. |

Metrics summarize rates, outcomes, latency and saturation. Logs explain individual operations. The Player's existing Performance graph and browser acceptance provide viewing evidence. Server readiness is not browser first frame, and an HTTP 200 is not proof of successful playback. `/health` stays cheap; `/api/debug` stays a snapshot and recent tail rather than a time-series store. Reuse the [playback preparation/readiness signals](user-interface.md#playback-wait-explanations); do not build another buffering classifier.

## Ownership and libraries

Use Pino behind a small injected `Logger` interface, with stable event names, approved fields, child context and no-op/test sinks. Its [official API](https://github.com/pinojs/pino/blob/main/docs/api.md) provides structured logging and serializers. A server-only `@magplay/observability` workspace holds this interface and narrow domain metrics interfaces/adapters. Keep Pino/Prometheus types out of domain APIs and browser bundles; no event bus, dependency-injection framework, global registry or work at import time.

`main.ts` owns a root logger, output, an optional metrics listener and final flush. `createApp()` owns its services, registry and samplers; packages receive only the interfaces they use and retain their own job ownership. Create safe bootstrap logging before settings/config loading so startup failures are visible. Parse options through server config helpers, not package reads of `process.env`. Close/flush within the existing 10-second shutdown deadline, including startup-failure paths. Replace first-party console calls and then remove console capture. Check dependency-owned output separately; it is outside the application's structured-output guarantee.

## Structured logs

Records contain UTC time, level, stable event name, readable message, component, service name `magplay`, app version and per-process `runId`. Include configuration revision on setting changes and subsequent operations so regressions can be related to changes without retaining configuration content. Durations use a monotonic clock and explicit units, such as `durationMs`, `startSeconds` and `bytes`. Errors have bounded type/message/code/stack/cause fields and safe handling of unknown thrown values.

Use server-generated `requestId`, returned as `X-Request-Id`, for HTTP work; generate an `operationId` for each playback preparation/search. Shared probes and torrent initialization have independent `jobId` values; joining consumers link to the job rather than making it belong to the first request. Retain `sessionId` and replacement links for HLS lifetimes. A torrent hash/file index and stable source ID may appear as operational log fields when needed, but filenames, queries, magnets and private link IDs do not. Hashes still reveal activity: these are local operational records, not anonymous analytics. Pass context explicitly initially, without request objects in packages or AsyncLocalStorage.

| Event owner | Record |
| --- | --- |
| Process/settings | Startup checks, listening, shutdown outcome/duration, configuration revision and changed key names, settings load/persistence failure. |
| HTTP | One terminal summary with method, matched route pattern, status, outcome and duration. Finish/close/error races must not duplicate it. Unmatched/malformed paths get constant labels. |
| Search/Explore | Aggregate outcome and per-source job outcome, result count and duration; degraded/recovered checks rather than every status poll. |
| Torrent/probe/subtitles | Job start, cache hit/join, metadata/verification stages, completion/failure/timeout and duration; unload/eviction and reclaimed bytes. |
| Playback/HLS | Preparation, mode/decision reason, server readiness, first published playable media, media process failure/exit, replacement and stop reason. Include a short sanitized stderr excerpt on failure, never full arguments/progress. |
| Resources | Admission rejection and disk-limit stops, with resource, used/limit/free values. |

Info captures important lifecycle changes and playback outcomes; warn captures expected operational degradation such as source timeout or resource rejection; error captures unexpected bugs and failed media/persistence/cleanup work. Debug adds request success and detailed cache/stage evidence. Expected user cancellation, replacement, idle cleanup and intentional process signals are not errors. The domain owner logs error detail once; HTTP can add a correlated outcome summary without repeating the stack.

Suppress successful health/static requests, polling, media ranges and HLS segment/playlist traffic at info. Keep their terminal summaries at debug. Routine client validation/not-found responses are debug; operational failures remain visible. Do not log piece progress, every ffmpeg tick or every CPU sample. Repeated background warnings may be coalesced with a bounded key set and a count summary.

### Redaction and bounds

Default to `LOG_LEVEL=info`, with `debug`, `info`, `warn`, `error`, `silent` accepted as environment-only restart settings. Both stdout and Debug consume the same sanitized, level-filtered records. The Settings severity selector narrows captured data; show the server capture level so it does not suggest debug records can be recovered afterward.

Never log whole env/config/request/response objects, bodies, headers, authorization/cookies, source/download/tracker URLs, full filesystem paths, filenames or search terms. Serialize approved error fields before sanitizing; mask secret keys case-insensitively, URL credentials and secret values embedded in messages, causes, stacks or stderr. Child context must use the same sanitizer. Maintain the browser-safe diagnostic redactor in `api-contract`; generic string redaction cannot identify every unknown secret, so approved fields are the primary boundary. See [Pino redaction](https://github.com/pinojs/pino/blob/main/docs/redaction.md) for the library safeguard.

Bound records to 8 KiB of valid UTF-8 JSON after sanitization, with an explicit truncation marker that retains correlation fields. Bound depth, arrays and causes before serialization; handle cycles without mutating caller data. Keep at most 200 records and 512 KiB in Debug. Use a bounded stdout destination (initial budget 1 MiB), count application-side drops and show them in Debug/metrics. Verify destination behavior before writing an adapter; avoid a custom priority queue or durable logging subsystem. A slow/broken collector must not create an unbounded queue or hold playback waiting on telemetry. Drop accounting covers destination drop/failure notifications and writes rejected after failure, not an exact inventory of pending writes lost when a sink fails. Loss under overload is acceptable and must be observable where measurable; flush does not promise durable delivery.

## Small metrics baseline

Use the maintained [Prometheus Node client](https://github.com/prometheus/client_js) with one registry per app; select and pin the release during implementation. Preparation outcomes count the response being prepared, while HLS readiness is observed only after playable media is published; its measurement includes the delay until the next progress/resource/status observation. Requested offsets and audio indexes stay in logs; the server does not infer browser action intent or cache class for metric labels. Metrics update at the operation owner independently of logging: verbosity, dropped logs and warning coalescing must not change counts. Count each preparation once, each shared job once, and consumer cancellation separately. Use fixed terminal outcomes: success, failure, timeout, rejected, cancelled. HTTP outcomes and media outcomes remain distinct.

| Family | Type and initial dimensions |
| --- | --- |
| `magplay_http_requests_total`, `magplay_http_request_duration_seconds` | Counter by route group/method/status class; duration histogram by route group. Keep media stream lifetimes distinct from control-API latency. |
| `magplay_playback_attempts_total`, `magplay_playback_ready_seconds` | Counter by mode/outcome; successful server-readiness histogram by mode. Show failures/cancellations alongside successful timing. |
| `magplay_jobs_total`, `magplay_job_duration_seconds` | Counter by job kind/outcome; histogram by kind for source fetch, torrent discovery/verification, probe, subtitles and HLS conversion. |
| `magplay_resource_in_use`, `magplay_resource_limit`, `magplay_resource_rejections_total` | Gauges by slot kind; rejection counter by resource and stable reason. |
| `magplay_storage_bytes`, `magplay_cache_entries` | Gauges from existing cache/disk snapshots by storage/cache kind, with freshness. |
| `magplay_telemetry_dropped_total` | Counter for application-side drop/failure events. |

Runtime metrics cover Node CPU seconds, resident memory, event-loop p99 and GC duration. These use owned Node observers and Prometheus instruments because the client's default collectors do not expose observer teardown. Node CPU excludes ffmpeg. Keep existing session speed/fps/CPU evidence in Debug and the Player initially; additional conversion aggregates, cache-efficiency and transfer counters wait for a demonstrated question. Missing/unsupported CPU or stale disk data must not become a healthy zero. Reuse owned resource snapshots and any cheap sampling needed to refresh them without requiring a browser; no new recursive cache scans, source tests or probes on scrape.

Use seconds, bytes and ratios, with `_total` for counters, following [Prometheus naming](https://prometheus.io/docs/practices/naming/). Metric labels use fixed route groups, modes, job/resource kinds and reason enums. IDs, hashes, raw paths, URLs, filenames, source names and arbitrary error strings stay out of labels. Normalize unknowns and test the enumerated application-series budget (initial target below 1,000 series including buckets). Keep app version in one build-info metric. [Instrumentation guidance](https://prometheus.io/docs/practices/instrumentation/) explains cardinality constraints.

Use aggregatable duration histograms with a small explicit bucket set suitable for control APIs versus preparations, and a separate longer range for cached-piece verification. Native histograms can be used when supported end to end, but are not an adoption prerequisite. Show sample counts, respect counter resets and do not treat a percentile from two plays as a baseline. See [histogram guidance](https://prometheus.io/docs/practices/histograms/). Establish real-server/device measurements before adopting latency objectives or percentage alerts.

Expose metrics through an optional management listener: `METRICS_ENABLED=false`, `METRICS_HOST=127.0.0.1`, `METRICS_PORT=9091`. Keep it out of the browser API/proxy. A container scraper needs an explicit internal-network bind or loopback-only host publication; never publish it broadly by default. Serve valid exposition with no-store, close it with the app and exclude scrape traffic from its own HTTP metrics. A starting scrape interval is 15 seconds with a 5-second timeout. Slot/cache gauges refresh every second; the existing single-flight disk/cache measurement refreshes every 30 seconds, independently of the browser. The observation timestamp makes stale disk data identifiable. Scrapes read bounded state and trigger no upstream work.

## Collection and retention

The baseline is JSON stdout → Docker's `local` driver, with the volatile Debug tail in parallel. Document rotation using `max-size: "10m"`, `max-file: "5"` and non-blocking delivery with `max-buffer-size: "1m"`. This is a starting per-container rotation budget, not guaranteed time retention or a filesystem quota. Use `docker compose logs --since …` and parse application JSON; do not tail Docker's private storage files. Docker documents [local rotation](https://docs.docker.com/engine/logging/drivers/local/) and [delivery mode tradeoffs](https://docs.docker.com/engine/logging/configure/). Driver drops happen after the app writes and cannot be inferred from its drop counter. Never write application log files under the media cache.

Existing infrastructure may scrape Prometheus metrics or collect stdout with Alloy/OpenTelemetry into Loki, Datadog or another backend. The app has no vendor credentials/export client and does not require a collector, database or dashboard to run. The repository also provides an opt-in local Compose profile for development troubleshooting: Prometheus, Loki, Alloy and Grafana stay on an internal network, while Grafana alone is published on loopback. It is a disposable local stack, not a required server deployment or a remote monitoring integration.

That profile keeps Prometheus data in a named volume with a 7-day or 1 GB TSDB limit, Loki data in a named volume with a 72-hour retention limit and modest ingestion/stream limits, and small CPU/memory limits on each backend. Alloy persists only its small local state volume and has finite retry backoff. The application remains responsible for bounded stdout delivery; neither app log drops nor Docker-driver drops can be reconstructed by the collector. Grafana provisions the metrics and log data sources plus a compact overview for playback outcomes/readiness, resources, telemetry drops and correlated JSON logs.

If centralized collection is later configured, preserve app timestamp, service/environment/host, severity, event and correlation fields; parse one JSON record per line, retain bounded fallback handling for dependency output and avoid duplicate readers. Index only bounded labels such as service/environment/level; IDs remain JSON fields or structured metadata, per [Loki guidance](https://grafana.com/docs/loki/latest/get-started/labels/). Set finite queues/retries, retention and storage caps in that deployment, keep data separate from media eviction, and monitor collection failure. Replays/loss are possible; metrics, not log-line counts, own outcome totals. Docker API access grants substantial privileges even with a read-only socket mount; reuse a trusted host collector where available.

## Investigation and extension gates

For a failure, find the request/preparation outcome in Debug or container logs, follow its operation/job/session IDs, then inspect stage durations, rejection/exit reasons and version/configuration revision. Compare aggregate metrics over that time window; use the Player/browser evidence if server output was ready but viewing stalled. Preserve an unknown conclusion when evidence cannot distinguish delivery, swarm, conversion or decoding. This workflow should work without a custom dashboard.

Only add centralized collection when local retention/search is insufficient; add dashboards/alerts when an existing monitoring deployment will use them. Alerts should identify sustained actionable failures, resource pressure or telemetry loss, with recovery behavior, and should not trigger for no viewing traffic, normal cancellation or a single slow sample. Add distributed tracing only if explicit operation/job context cannot explain a concrete case; use standard trace/span IDs and links for shared jobs then. Browser telemetry ingestion, session replay, continuous profiling, automated remediation and AI incident analysis are out of scope. The single-service design and real-device playback goals remain the reason to choose each addition.

## Local use

```sh
LOG_LEVEL=debug npm start
docker compose logs --since 10m --no-log-prefix magplay
METRICS_ENABLED=true npm start
curl http://127.0.0.1:9091/metrics
```

To use the repository's optional local stack, start the profile from a trusted development checkout:

```sh
docker compose --profile observability up -d --build
open http://127.0.0.1:3000
```

The Compose service enables the app's private metrics listener on its internal `observability` network. Prometheus scrapes it every 15 seconds; Alloy selects only the current Compose project's `magplay` container and sends its Docker JSON logs to Loki. Grafana is loopback-only and permits anonymous Viewer access, so do not change its binding or use the profile on a host shared with untrusted local users. The Alloy Docker socket mount is read-only but still grants powerful control-plane access; use it only on a trusted development host, prefer an existing trusted host collector in deployment, and remove the profile rather than mounting the socket on an untrusted server.

Stop only the local backends while leaving magplay running with:

```sh
docker compose stop grafana alloy loki prometheus
docker compose rm -f grafana alloy loki prometheus
```

Their named volumes preserve the bounded local history. `docker compose down --volumes` removes the entire development project, including magplay's cache volume, and is appropriate only when that data may be discarded. Run `npm run test:observability` to validate an isolated copy of the profile; it removes its containers and volumes automatically.

For an existing host Prometheus collector, explicitly enable metrics on magplay and add a scrape job (use the application's reachable private address):

```yaml
scrape_configs:
  - job_name: magplay
    scrape_interval: 15s
    scrape_timeout: 5s
    static_configs:
      - targets: ["127.0.0.1:9091"]
```

In Docker, set `METRICS_ENABLED=true` and `METRICS_HOST=0.0.0.0` explicitly, then either use an isolated shared monitoring network or publish only `127.0.0.1:9091:9091` for a host collector. A collector in a different container cannot use its own loopback to reach magplay. `/metrics` is not available on port 8080. Stop the service or remove the explicit opt-in when metrics collection is no longer wanted.
