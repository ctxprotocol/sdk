# Changelog

## 0.22.0

- Added `bounded_explicit_empty_result_guardrail` to `QueryControllerStopReason` so strict consumers no longer fail validation when the platform returns that live stop reason.
- Platform note (no type change): `computed_artifacts` is now capped at 4 per response by the shared artifact emission policy, so SDK/MCP consumers receive exactly the artifact list the web app displays for the identical run.

## 0.21.0

- `client.query.run()` is now backed by the durable job path (`start()` + `poll()`) instead of a held-open SSE connection. One call now reliably covers the full 1800s hosted compute ceiling and survives transient connection drops — the "sometimes works, sometimes times out on hard queries" failure mode is gone. `run()` accepts optional `QueryPollOptions` as a second argument.
- `runOrPoll()` is kept as an explicit alias of the same path, and now also normalizes capability-miss outcomes and synthesizes a fallback developer trace when `includeDeveloperTrace` is set but the backend omits the trace (matching prior `run()` behavior).
- `client.query.stream()` is unchanged and remains the real-time SSE surface.

## 0.20.0

- Poll defaults aligned with the hosted 1800s compute ceiling: `poll()`/`runOrPoll()` check status every 5 seconds over plain HTTP and wait up to 31 minutes by default.
- Documented that HTTP polling costs no model tokens; model turns do.

## 0.19.0

- Typed rendered image artifacts so consumers can narrow on `kind: "image"` and read the hosted image `url`. Previously `QueryComputedArtifact` only modeled the `chart` variant, so image artifacts narrowed to `never` and their `url` was unreachable in a type-safe way.
- Added `QueryImageArtifact` (`kind: "image"` with `url`, `alt`, `title`, `contentHash`, `bytes`, `width`, `height`) and split `QueryComputedArtifact` into a `QueryChartArtifact | QueryImageArtifact` union.
- Exported `QueryChartArtifact` and `QueryImageArtifact` from the root and client entry points.

## 0.18.0

- Added durable async Query jobs with `client.query.start()`, `client.query.getStatus()`, and `client.query.poll()`.
- Exported `QueryJobStartResult`, `QueryJobStatusResult`, `QueryJobStatus`, and `QueryPollOptions` from the root and client entry points.
- Kept existing `client.query.run()` and `client.query.stream()` behavior unchanged.
