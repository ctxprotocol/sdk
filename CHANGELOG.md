# Changelog

## 0.18.0

- Added durable async Query jobs with `client.query.start()`, `client.query.getStatus()`, and `client.query.poll()`.
- Exported `QueryJobStartResult`, `QueryJobStatusResult`, `QueryJobStatus`, and `QueryPollOptions` from the root and client entry points.
- Kept existing `client.query.run()` and `client.query.stream()` behavior unchanged.
