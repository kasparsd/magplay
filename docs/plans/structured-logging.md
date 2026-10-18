# Logging and observability implementation

## Goal and status

Plan created 2026-10-18 and revised after studying [Datadog's observability guide](https://www.datadoghq.com/knowledge-center/observability/). The local implementation is complete; real-server/device evidence remains pending. Deliver the architecture in [docs/logging.md](../logging.md) so the owner can explain playback failures and slow startup/seek on the actual server. That document owns design decisions and operating limits; this file owns tasks, sequencing and acceptance evidence.

## Planning completed

- [x] Review the roadmap, architecture, resources, lifecycles, deployment acceptance, Settings/Debug and current logging call sites.
- [x] Review metrics/cardinality, log collection/retention and the Datadog guide; apply correlation, change context and investigation principles to the single-user LAN app.
- [x] Consolidate architecture in `docs/logging.md`; reduce the initial metrics set and remove the requirement to build collectors, dashboards, durable queues or alerting infrastructure.
- [x] Keep the metrics endpoint opt-in, tracing conditional and real browser/device measurements distinct from server readiness.

## Starting gaps and coordination

At the start, `apps/server/src/logs.ts` globally patched console methods and stored formatted text. Severity was inconsistent, and some known operational failures had no useful record. There were no linked stage timings, metrics registry or byte bounds on records. The string redactor did not mask arbitrary nested secret keys, and errors needed explicit serialization. These gaps are now addressed.

The [playback-wait work](playback-wait-explanations.md) changes `services/play.ts`, routes, HLS and API contracts. Reuse its preparation/readiness evidence after it settles and preserve ongoing edits. Instrument shared jobs at their owner without changing consumer cancellation, admission limits, `/raw`/`/tar` delivery or shutdown ownership. Avoid a Player controller rewrite.

## Phase 1: logging foundation

- [x] Add the server-only observability workspace, pinned Pino dependency, narrow logger/metrics interfaces and no-op/test implementations; update manifests, lockfile, project references and lint boundaries.
- [x] Implement approved record/error fields, child context, shared sanitizer, bounded output/Debug tail and drop accounting according to the canonical doc. Verify the library destination's queue/drop/flush support before adding custom plumbing.
- [x] Wire bootstrap logging and validated options through config/settings/main; include version/run and configuration-change context. Ensure early failure and shutdown flush within the existing deadline.
- [x] Verify nested secrets, URL credentials, error causes/stacks/stderr, child bindings, circular/multibyte/oversized values, level filtering, sink failure and independent logger instances.

## Phase 2: request, operation and job evidence

- [x] Add matched route metadata to `http-kit` matches; generate/return request IDs and emit one terminal request outcome across finish/close/error races.
- [x] Inject loggers into app services and indexer/torrent/playback factories. Link preparation, shared jobs and HLS sessions; include stage duration, mode/reason and terminal outcome.
- [x] Record source degradation/recovery, media-tool failure excerpts, resource rejection, eviction and intentional stop reasons at the specified severity. Convert first-party console calls without duplicate error detail or poll/segment spam.
- [x] Verify successful direct/remux/seek flows and representative source timeout, dead swarm, failed probe/ffmpeg, overload, disk pressure, shared-job cancellation and expected process signals. Use existing fixtures and fault injection.

## Phase 3: small metrics baseline

- [x] Add a pinned Prometheus client and per-app registry; implement only the baseline families in `docs/logging.md`, with typed finite dimensions and runtime metrics.
- [x] Record operation/job outcomes once independently of log calls. Reuse bounded resource snapshots; maintain useful freshness without an open browser and avoid upstream work or disk walks on scrape.
- [x] Add the optional private management listener, config validation, content type/no-store and clean close; document one scrape example and container binding requirements.
- [x] Verify counters/histograms, cancellation/shared-job semantics, label normalization/series budget, multiple app instances, stale/missing values, scrape side effects and independence from logging verbosity/drops.

## Phase 4: Debug and local collection

- [x] Update `DebugInfo`, Settings log rendering and copied diagnostics together; keep readable time/level/message and correlation details, capture-level visibility and application drop counts.
- [x] Remove console capture after first-party call sites are converted; check dependency-owned output separately.
- [x] Document bounded Docker rotation, log inspection and the external collection contract in the canonical doc/README. Update existing resources, lifecycle, UI and deployment acceptance documents only where delivered behavior changes; keep the roadmap accurate.
- [x] Verify stdout and Debug sanitization agree, production output parses, local Docker rotation works and the app remains usable with no scraper/collector or a blocked sink. No collector/backend stack is an implementation deliverable.

## Phase 5: acceptance and evidence

- [x] Run focused checks, `npm run typecheck`, `npm run lint`, `npm run test:all` and the isolated Docker acceptance because runtime dependencies, packaging and lifecycle paths change.
- [x] Extend production-image acceptance to verify structured startup/playback/shutdown records, redaction, the optional metrics listener and final flush on SIGTERM/startup failure.
- [x] Compare a representative generated-media flow with telemetry enabled versus disabled for readiness latency, event-loop delay, memory and log/series volume; investigate material overhead rather than invent a performance claim. Exercise unique IDs, repeated failures and sink backpressure to verify bounds.
- [ ] Record actual deployment/device timings and long-session resource behavior when access is available, using the existing deployment acceptance procedure and dated checkpoints. Keep this gate pending until measured; synthetic fixtures do not establish server capacity or browser experience.

## Done when

- [x] A failed play can be followed from request through preparation and any shared job/session to one useful final reason; a remux/seek includes honest server stage timings.
- [x] Settings changes/version/run can be related to subsequent operations without exposing configuration values.
- [x] Metrics remain accurate when logs are suppressed/dropped; labels, queues and tails stay bounded and scrapes trigger no expensive work.
- [x] Normal cancellation/replacement/shutdown is not a false error, and instrumentation preserves current resource/lifetime guarantees.
- [x] Logs, Debug and copied diagnostics are sanitized; media requests/polls remain quiet at default verbosity.
- [x] Standalone Docker inspection works without extra infrastructure, the metrics listener is private/optional, and missing telemetry is visible rather than presented as a healthy zero.
- [x] Local acceptance evidence passes and documentation clearly distinguishes implemented behavior from outstanding real-server/device validation.

## Delivery evidence

Implemented `@magplay/observability`, replaced console capture, instrumented HTTP/services/shared jobs and conversion lifetimes, added optional private Prometheus exposure, and updated Debug and Docker rotation. Operation context includes request/configuration revision; shared jobs retain independent IDs. HLS preparation and observed first playable media are separate events/measurements. Runtime observers have explicit teardown because the Prometheus client's default collectors do not provide it. Metrics omit browser action/cache-class labels that the server cannot reliably infer.

Validation and the generated-media comparison are in [the dated checkpoint](../checkpoints/2026-10-18-logging.md). No collector, dashboard or remote service was deployed. The remaining unchecked item requires the actual server/devices; it does not block the local implementation.
