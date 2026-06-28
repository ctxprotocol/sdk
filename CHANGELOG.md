# Changelog

## 0.19.0

- Typed rendered image artifacts so consumers can narrow on `kind: "image"` and read the hosted image `url`. Previously `QueryComputedArtifact` only modeled the `chart` variant, so image artifacts narrowed to `never` and their `url` was unreachable in a type-safe way.
- Added `QueryImageArtifact` (`kind: "image"` with `url`, `alt`, `title`, `contentHash`, `bytes`, `width`, `height`) and split `QueryComputedArtifact` into a `QueryChartArtifact | QueryImageArtifact` union.
- Exported `QueryChartArtifact` and `QueryImageArtifact` from the root and client entry points.

## 0.18.0

- Added durable async Query jobs with `client.query.start()`, `client.query.getStatus()`, and `client.query.poll()`.
- Exported `QueryJobStartResult`, `QueryJobStatusResult`, `QueryJobStatus`, and `QueryPollOptions` from the root and client entry points.
- Kept existing `client.query.run()` and `client.query.stream()` behavior unchanged.
